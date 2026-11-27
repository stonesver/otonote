"""JP client identities anchored to reviewed metadata; no secret material on disk."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import struct

from tools.bundle_decoder import field_bytes, relocated_profile

PROFILE_NAME = 'seed-manifest.json'
ANCHOR_NAME = 'trusted-metadata.v39.dat'
MAX_METADATA_BYTES = 128 * 1024 * 1024
NETWORK_INDICES = (43395, 41482)
NETWORK_BINDINGS_ENV = 'OURNOTES_JP_NETWORK_BINDINGS'


def reviewed_network_indices(version, metadata_sha):
    """Read operator-reviewed rotations without publishing real client mappings."""
    raw = os.environ.get(NETWORK_BINDINGS_ENV, '')
    if not raw:
        return None
    try:
        if len(raw) > 65536:
            raise ValueError
        rows = json.loads(raw)
        if not isinstance(rows, list) or not rows:
            raise ValueError
        bindings = {}
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'clientVersion', 'metadataSha256', 'networkIndices'}:
                raise ValueError
            identity = (row['clientVersion'], row['metadataSha256'])
            indices = row['networkIndices']
            if (not isinstance(identity[0], str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,4}', identity[0])
                    or not isinstance(identity[1], str) or not re.fullmatch('[a-f0-9]{64}', identity[1])
                    or not isinstance(indices, list) or len(indices) != 2
                    or any(type(i) is not int or not 0 <= i < 1_000_000 for i in indices)
                    or identity in bindings):
                raise ValueError
            bindings[identity] = indices
        return bindings.get((version, metadata_sha))
    except (ValueError, TypeError):
        raise ValueError('invalid reviewed JP network bindings') from None


def read_metadata(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_METADATA_BYTES:
        raise ValueError('JP metadata is missing, linked or oversized')
    return path.read_bytes()


def legacy_binding():
    from tools.jp_phone_inputs import JP_CLIENT_VERSION, JP_METADATA_SHA256
    return {'clientVersion': JP_CLIENT_VERSION, 'metadataSha256': JP_METADATA_SHA256,
            'decoderProfile': {'clientVersion': JP_CLIENT_VERSION, 'metadataSha256': JP_METADATA_SHA256,
                               'keyFieldUsage': 0x8000020B, 'nonceSeedFieldUsage': 0x80000213},
            'networkIndices': list(NETWORK_INDICES)}


def literal_values(data):
    """Read bounded v39 literal ranges; never include literals in diagnostics."""
    if len(data) < 380 or struct.unpack_from('<II', data) != (0xFAB11BAF, 39):
        raise ValueError('unexpected JP metadata format')
    offset, size, _ = struct.unpack_from('<III', data, 8)
    strings, string_size, _ = struct.unpack_from('<III', data, 20)
    if (size < 8 or size % 4 or size // 4 > 1_000_001 or offset < 380 or strings < 380
            or offset + size > len(data) or strings + string_size > len(data)):
        raise ValueError('invalid JP credential literal table')
    result = []
    for index in range(size // 4 - 1):
        start, end = struct.unpack_from('<II', data, offset + index * 4)
        # Unused/encoded slots are not candidates. A selected credential must
        # still resolve to one valid bounded range and match the trusted bytes.
        result.append(data[strings+start:strings+end] if 0 <= start < end <= string_size and end-start in (6,32) else None)
    return result


def credentials(data, indices):
    values = literal_values(data)
    if (not isinstance(indices, list) or len(indices) != 2
            or any(type(i) is not int or not 0 <= i < len(values) for i in indices)):
        raise ValueError('invalid JP NetworkConfig binding')
    pair = tuple(values[i] for i in indices)
    if (any(value is None for value in pair) or tuple(map(len, pair)) != (6, 32)
            or any(byte < 0x21 or byte > 0x7e for value in pair for byte in value)):
        raise ValueError('unreviewed JP NetworkConfig literals')
    return pair


def derive_binding(anchor_path, metadata_path, version):
    from tools.jp_phone_inputs import JP_METADATA_SHA256
    from analysis.crypto.inspect_il2cpp import MetadataV39
    if not isinstance(version, str) or not re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,4}', version) or len(version) > 64:
        raise ValueError('invalid JP binding version')
    anchor = read_metadata(anchor_path)
    if hashlib.sha256(anchor).hexdigest() != JP_METADATA_SHA256:
        raise ValueError('JP trusted metadata anchor mismatch')
    current = read_metadata(metadata_path)
    old = MetadataV39(Path(anchor_path))
    parsed = MetadataV39(Path(metadata_path))
    key = field_bytes(old, 0x8000020B, 16)
    seed = field_bytes(old, 0x80000213, 8)
    row = relocated_profile(parsed, version, key, seed)
    current_sha = hashlib.sha256(current).hexdigest()
    reviewed = reviewed_network_indices(version, current_sha)
    if reviewed is not None:
        indices = list(reviewed)
        credentials(current, indices)
        return {'clientVersion': version, 'metadataSha256': current_sha,
                'decoderProfile': row, 'networkIndices': indices}
    known = credentials(anchor, list(NETWORK_INDICES))
    literals = literal_values(current)
    indices = []
    for value in known:
        matches = [i for i, item in enumerate(literals) if item == value]
        if len(matches) != 1:
            raise ValueError('JP NetworkConfig material has no unique new location')
        indices.append(matches[0])
    return {'clientVersion': version, 'metadataSha256': hashlib.sha256(current).hexdigest(),
            'decoderProfile': row, 'networkIndices': indices}


def read_receipt(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise ValueError('JP client binding receipt absent or unsafe')
    row = json.loads(path.read_bytes())
    if not isinstance(row, dict):
        raise ValueError('invalid JP client binding receipt')
    return row


def load_binding(metadata_path):
    path = Path(metadata_path)
    sha = hashlib.sha256(read_metadata(path)).hexdigest()
    legacy = legacy_binding()
    profile_path = path.parent / PROFILE_NAME
    receipt = read_receipt(profile_path) if profile_path.exists() or profile_path.is_symlink() else {}
    if sha == legacy['metadataSha256'] and receipt.get('schemaVersion') != 2:
        return legacy
    if (receipt.get('schemaVersion') != 2 or receipt.get('status') != 'verified_seed'
            or receipt.get('signatureVerified') is not True or receipt.get('metadataSha256') != sha):
        raise ValueError('invalid JP client binding receipt')
    expected = derive_binding(path.parent / ANCHOR_NAME, path, receipt.get('clientVersion'))
    if receipt.get('binding') != expected:
        raise ValueError('JP client binding differs from trusted material')
    return expected


def validate_package(metadata, apk_root, package=None):
    """Match a restored APK set to its anchored metadata and intake receipt."""
    from tools import jp_phone_inputs as pins
    from tools.resource_pipeline.package_intake import build_package_set_manifest
    apk_root = Path(apk_root)
    if apk_root.is_symlink() or any(path.is_symlink() for path in apk_root.glob('*.apk')):
        raise ValueError('linked JP client package')
    package = package or build_package_set_manifest(apk_root, region='jp', channel='production')
    binding = load_binding(metadata)
    profile_path = Path(metadata).parent / PROFILE_NAME
    receipt = read_receipt(profile_path) if profile_path.exists() or profile_path.is_symlink() else {}
    if receipt.get('schemaVersion') != 2:
        expected = (pins.JP_CLIENT_VERSION, pins.JP_VERSION_CODE, pins.JP_REVIEWED_PACKAGE_SET_SHA256)
    else:
        if (receipt.get('certificateSha256') != pins.JP_CERTIFICATE_SHA256
                or type(receipt.get('versionCode')) is not int or receipt['versionCode'] <= pins.JP_VERSION_CODE
                or receipt.get('apks') != {r['logicalName']:r['sha256'] for r in package.get('splits', [])}):
            raise ValueError('JP verified client package receipt mismatch')
        expected = (binding['clientVersion'], receipt['versionCode'], receipt.get('packageSetSha256'))
    actual = (package.get('versionName'), package.get('versionCode'), package.get('packageSetSha256'))
    if (actual != expected or package.get('certificateSha256') != pins.JP_CERTIFICATE_SHA256
            or package.get('packageName') != 'com.bushiroad.sirius'):
        raise ValueError('unreviewed JP package or metadata')
    return package, binding
