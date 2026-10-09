"""Download, verify and select a compatible official APK for resource decoding."""
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit
import zipfile

from tools.global_remote_sync import acquire, file_hash, read_json, write_json, verify_apk_signature
from tools.resource_pipeline.package_intake import inspect_apk
from tools.resource_pipeline.adapters.global_public import APK_HOSTS, APK_USER_AGENT

CERTIFICATE = 'bf683e367551a3f629b90e16a63b315af74e387bcc5d94f26dcd626e7eea3637'
APKSIG_SHA256 = '7ae2e5980c77d853e3513074ee7c822bbdcdcde1668889d17faa7fe8bc8aa821'


def _verified_prior_material(cache, apksig):
    """Read material only from an exact external binding and verified APK receipt."""
    from analysis.crypto.decrypt_global_formal_scores import MetadataV39
    from tools.bundle_decoder import PROFILE_ENV, _profile_entries, resolve_bundle_decoder
    profile_path = os.environ.get(PROFILE_ENV)
    if not profile_path:
        raise ValueError('bundle decoder profile is required')
    trusted = {(row['clientVersion'], row['metadataSha256']) for row in _profile_entries(profile_path)}
    receipts = []
    for path in cache.glob('*/decoder.json'):
        if re.fullmatch('[a-f0-9]{64}', path.parent.name) and not path.is_symlink():
            row = read_json(path)
            if (row.get('clientVersion'), row.get('metadataSha256')) in trusted:
                version = row['clientVersion']
                if re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,4}', version):
                    receipts.append((tuple(map(int, version.split('.'))), path, row))
    if not receipts:
        raise ValueError('no verified prior bundle decoder receipt')
    _, receipt_path, receipt = max(receipts, key=lambda item: (item[0], str(item[1])))
    metadata = receipt_path.parent / 'global-metadata.v39.dat'
    apk = Path(receipt.get('apk', ''))
    if (receipt.get('apkSha256') != receipt_path.parent.name or
            receipt.get('certificateSha256') != CERTIFICATE or receipt.get('signatureVerified') is not True or
            not metadata.is_file() or metadata.is_symlink() or
            Path(receipt.get('metadata', '')) != metadata or
            not apk.is_file() or apk.is_symlink() or cache / 'downloads' not in apk.parents or
            file_hash(metadata) != receipt['metadataSha256'] or file_hash(apk) != receipt['apkSha256']):
        raise ValueError('prior bundle decoder receipt integrity mismatch')
    identity = inspect_apk(apk)
    if (identity['versionName'] != receipt['clientVersion'] or
            identity['certificateSha256'] != CERTIFICATE or
            identity['packageName'] not in ('com.bilibili.sirius.official', 'com.bilibili.sirius')):
        raise ValueError('prior APK identity mismatch')
    verify_apk_signature(apk, apksig, CERTIFICATE)
    parsed = MetadataV39(metadata)
    return resolve_bundle_decoder(parsed, receipt['clientVersion'])[:2]


def _verify_packaged_bundles(apk, key, seed, decrypt_header):
    """Require three distinct packaged ciphertexts to decode as UnityFS."""
    verified = []
    with zipfile.ZipFile(apk) as archive:
        choices = sorted((info for info in archive.infolist()
                          if info.filename.endswith('.bundle') and 128 <= info.file_size <= 1_000_000),
                         key=lambda info: (info.file_size, info.filename))
        for info in choices:
            with archive.open(info) as member:
                header = member.read(min(info.file_size, 16 * 1024))
            if header.startswith(b'UnityFS\0'):
                continue
            try:
                clear = decrypt_header(header, Path(info.filename).name, key, seed)
            except ValueError:
                raise ValueError('new APK bundle decoder validation failed') from None
            if not clear.startswith(b'UnityFS\0'):
                raise ValueError('new APK bundle decoder validation failed')
            verified.append(info.filename)
            if len(verified) == 3:
                return verified
    raise ValueError('new APK has fewer than three encrypted validation bundles')


def _resolve_current_binding(parsed, version, apk, cache, apksig):
    from analysis.crypto.decrypt_global_formal_scores import decrypt_header
    from tools.bundle_decoder import relocated_profile, resolve_bundle_decoder
    try:
        _, _, binding = resolve_bundle_decoder(parsed, version)
        return binding, None
    except ValueError as exc:
        if str(exc) != 'unsupported bundle decoder binding':
            raise
    known_key, known_seed = _verified_prior_material(cache, apksig)
    row = relocated_profile(parsed, version, known_key, known_seed)
    key, seed, binding = resolve_bundle_decoder(parsed, version, profile=row)
    if key != known_key or seed != known_seed:
        raise ValueError('relocated bundle decoder material changed')
    _verify_packaged_bundles(apk, key, seed, decrypt_header)
    return binding, row


def intake(package, cache, apksig):
    cache, apksig = Path(cache), Path(apksig)
    if file_hash(apksig) != APKSIG_SHA256: raise ValueError('APK verifier library digest mismatch')
    name = Path(urlsplit(package['url']).path).name
    package_id = hashlib.sha256(json.dumps({k: package[k] for k in ('url', 'byteSize', 'etag')}, sort_keys=True).encode()).hexdigest()[:24]
    apk = cache / 'downloads' / package_id / name
    download_options = ({'allowed_hosts': APK_HOSTS, 'request_headers': {'User-Agent': APK_USER_AGENT}}
                        if urlsplit(package['url']).hostname in APK_HOSTS else {})
    acquire(package['url'], apk, package['byteSize'], expected_etag=package['etag'], **download_options)
    sha = file_hash(apk)
    profile_path = cache / sha / 'decoder.json'
    if profile_path.exists():
        profile = read_json(profile_path)
        if (profile.get('apkSha256') != sha or profile.get('certificateSha256') != CERTIFICATE
                or profile.get('signatureVerified') is not True or file_hash(Path(profile['metadata'])) != profile['metadataSha256']
                or (package.get('clientVersion') and profile.get('clientVersion') != package['clientVersion'])):
            raise ValueError('cached decoder profile integrity mismatch')
        from analysis.crypto.decrypt_global_formal_scores import MetadataV39
        from tools.bundle_decoder import resolve_bundle_decoder
        parsed = MetadataV39(Path(profile['metadata']))
        derived = profile.get('bundleDecoderProfile')
        if derived is not None:
            from analysis.crypto.decrypt_global_formal_scores import decrypt_header
            verify_apk_signature(apk, apksig, CERTIFICATE)
            key, seed, binding = resolve_bundle_decoder(parsed, profile['clientVersion'], profile=derived)
            _verify_packaged_bundles(apk, key, seed, decrypt_header)
        else:
            _, _, binding = resolve_bundle_decoder(parsed, profile['clientVersion'])
        if profile.get('bundleDecoderBindingSha256', binding) != binding:
            raise ValueError('cached bundle decoder binding mismatch')
        return {**profile, 'bundleDecoderBindingSha256': binding}
    identity = inspect_apk(apk)
    if package.get('clientVersion') and identity['versionName'] != package['clientVersion']:
        raise ValueError('official APK version differs from the recommended client version')
    if identity['packageName'] not in ('com.bilibili.sirius.official','com.bilibili.sirius'):
        raise ValueError('unexpected APK package identity')
    if identity['certificateSha256'] != CERTIFICATE: raise ValueError('APK signer changed')
    verify_apk_signature(apk, apksig, CERTIFICATE)
    from analysis.crypto.deobfuscate_paged_il2cpp_metadata import decode, read_sections
    from analysis.crypto.decrypt_global_formal_scores import MetadataV39
    from tools.extract_global_stories import command_enum
    with zipfile.ZipFile(apk) as archive:
        names = [n for n in archive.namelist() if n.endswith('/global-metadata.dat')]
        if len(names) != 1: raise ValueError('APK does not contain a unique IL2CPP metadata file')
        raw = archive.read(names[0])
    if raw[:4] == bytes.fromhex('af1bb1fa'):
        clear = raw
    else:
        clear, _ = decode(raw, key=0x66, version=39, page_size=4096, period_pages=16, xor_page_residues={1,2,3,4})
    read_sections(clear)
    metadata = profile_path.parent / 'global-metadata.v39.dat'
    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_bytes(clear)
    parsed = MetadataV39(metadata)
    binding, derived = _resolve_current_binding(parsed, identity['versionName'], apk, cache, apksig)
    command_enum(parsed)
    # Actual resource decryption is checked by each extractor before publication.
    profile = {'schemaVersion': 1, 'apk': str(apk.resolve()), 'apkSha256': sha,
        'metadata': str(metadata.resolve()), 'metadataSha256': file_hash(metadata),
        'clientVersion': identity['versionName'], 'versionCode': identity['versionCode'],
        'packageName': identity['packageName'], 'certificateSha256': CERTIFICATE,
        'signatureVerified': True, 'bundleDecoderBindingSha256': binding, 'decoder': 'global-v39-paged-xor-66', 'gameplayVerified': False}
    if derived is not None:
        profile['bundleDecoderProfile'] = derived
    write_json(profile_path, profile)
    return profile
