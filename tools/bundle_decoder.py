"""Resolve exact bundle bindings and verify relocation of trusted material.

Profiles contain FieldRef indices, never keys. Unknown metadata can reuse
previously verified material only at unique new FieldRefs, after packaged
bundle validation by the caller. Runtime resource decoding uses the resulting
exact version and metadata binding.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import struct

PROFILE_ENV = 'OURNOTES_BUNDLE_DECODER_PROFILE'
_FIELDS = {'clientVersion', 'metadataSha256', 'keyFieldUsage', 'nonceSeedFieldUsage'}


def _profile_entries(path):
    try:
        raw = Path(path).read_bytes()
        if len(raw) > 262144: raise ValueError
        document = json.loads(raw)
        if (not isinstance(document, dict) or set(document) != {'schemaVersion', 'profiles'}
                or type(document['schemaVersion']) is not int or document['schemaVersion'] != 1
                or not isinstance(document['profiles'], list) or not document['profiles']):
            raise ValueError
        seen = set()
        for row in document['profiles']:
            _validate_row(row)
            binding = (row['clientVersion'], row['metadataSha256'])
            if binding in seen: raise ValueError
            seen.add(binding)
        return document['profiles']
    except (OSError, ValueError, TypeError, UnicodeError):
        raise ValueError('invalid bundle decoder profile') from None


def _validate_row(row):
    if not isinstance(row, dict) or set(row) != _FIELDS: raise ValueError
    version, digest = row['clientVersion'], row['metadataSha256']
    if (not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,63}', version)
            or not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest)):
        raise ValueError
    for name in ('keyFieldUsage', 'nonceSeedFieldUsage'):
        usage = row[name]
        if type(usage) is not int or not 0x80000001 <= usage <= 0x9FFFFFFF or usage & 0xE0000001 != 0x80000001:
            raise ValueError
    if row['keyFieldUsage'] == row['nonceSeedFieldUsage']: raise ValueError


def _binding(metadata, client_version, profile_path):
    path = profile_path if profile_path is not None else os.environ.get(PROFILE_ENV)
    if not path: raise ValueError('bundle decoder profile is required')
    rows = _profile_entries(path)
    identity = hashlib.sha256(metadata.data).hexdigest()
    selected = next((row for row in rows if row['clientVersion'] == client_version
                     and row['metadataSha256'] == identity), None)
    if selected is None: raise ValueError('unsupported bundle decoder binding')
    return selected


def resolve_bundle_decoder(metadata, client_version, *, profile_path=None, profile=None):
    """Read one profile snapshot and bind the returned material to its receipt."""
    if profile is None:
        selected = _binding(metadata, client_version, profile_path)
    else:
        try:
            _validate_row(profile)
        except (ValueError, TypeError):
            raise ValueError('invalid bundle decoder profile') from None
        if (profile['clientVersion'] != client_version or
                profile['metadataSha256'] != hashlib.sha256(metadata.data).hexdigest()):
            raise ValueError('unsupported bundle decoder binding')
        selected = profile
    binding = hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return (field_bytes(metadata, selected['keyFieldUsage'], 16),
            field_bytes(metadata, selected['nonceSeedFieldUsage'], 8), binding)


def bundle_material(metadata, client_version, *, profile_path=None):
    return resolve_bundle_decoder(metadata, client_version, profile_path=profile_path)[:2]


def field_bytes(metadata, usage: int, length: int) -> bytes:
    """Resolve an IL2CPP FieldRef usage to its FieldRVA default bytes."""
    index = (usage & 0x1FFFFFFF) >> 1
    refs_offset, _, refs_count = metadata.sections[22]
    if index >= refs_count:
        raise ValueError("FieldRef usage is outside metadata")
    type_index, local_field = struct.unpack_from("<II", metadata.data, refs_offset + index * 8)
    owners = [
        i for i in range(metadata.type_count)
        if struct.unpack_from("<I", metadata.data, metadata.type_offset + i * 82 + 8)[0] == type_index
    ]
    if len(owners) != 1 or metadata.type_name(owners[0]) != "<PrivateImplementationDetails>":
        raise ValueError("FieldRef owner is not the expected private implementation type")
    # v39 TypeDefinition fieldStart is at byte 26 in its 82-byte record.
    field_start = struct.unpack_from("<I", metadata.data, metadata.type_offset + owners[0] * 82 + 26)[0]
    field_index = field_start + local_field
    defaults_offset, _, defaults_count = metadata.sections[7]
    matches = [
        data_index
        for i in range(defaults_count)
        for current, _, data_index in (struct.unpack_from("<III", metadata.data, defaults_offset + i * 12),)
        if current == field_index
    ]
    if len(matches) != 1:
        raise ValueError("FieldRef has no unique default value")
    data_offset, data_size, _ = metadata.sections[8]
    if matches[0] + length > data_size:
        raise ValueError("FieldRef default value exceeds the data section")
    return metadata.data[data_offset + matches[0]:data_offset + matches[0] + length]


def relocated_profile(metadata, client_version: str, known_key: bytes, known_seed: bytes) -> dict:
    """Locate the same verified material at unique FieldRefs in new metadata."""
    if len(known_key) != 16 or len(known_seed) != 8:
        raise ValueError('invalid prior bundle decoder material')
    data = metadata.data
    owners = {}
    for index in range(metadata.type_count):
        token = struct.unpack_from('<I', data, metadata.type_offset + index * 82 + 8)[0]
        owners.setdefault(token, []).append(index)
    defaults_offset, _, defaults_count = metadata.sections[7]
    defaults = {}
    for index in range(defaults_count):
        field_index, _, data_index = struct.unpack_from('<III', data, defaults_offset + index * 12)
        defaults.setdefault(field_index, []).append(data_index)
    refs_offset, _, refs_count = metadata.sections[22]
    data_offset, data_size, _ = metadata.sections[8]
    keys, seeds = [], []
    for index in range(refs_count):
        token, local_field = struct.unpack_from('<II', data, refs_offset + index * 8)
        matches = owners.get(token, [])
        if len(matches) != 1 or metadata.type_name(matches[0]) != '<PrivateImplementationDetails>':
            continue
        field_start = struct.unpack_from('<I', data, metadata.type_offset + matches[0] * 82 + 26)[0]
        positions = defaults.get(field_start + local_field, [])
        if len(positions) != 1:
            continue
        start = positions[0]
        usage = 0x80000001 | (index << 1)
        if start + 16 <= data_size and data[data_offset + start:data_offset + start + 16] == known_key:
            keys.append(usage)
        if start + 8 <= data_size and data[data_offset + start:data_offset + start + 8] == known_seed:
            seeds.append(usage)
    if len(keys) != 1 or len(seeds) != 1 or keys[0] == seeds[0]:
        raise ValueError('verified bundle material has no unique new FieldRefs')
    row = {'clientVersion': client_version, 'metadataSha256': hashlib.sha256(data).hexdigest(),
           'keyFieldUsage': keys[0], 'nonceSeedFieldUsage': seeds[0]}
    _validate_row(row)
    return row

