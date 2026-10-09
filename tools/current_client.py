"""Download, verify and select a compatible official APK for resource decoding."""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
import zipfile

from tools.global_remote_sync import acquire, file_hash, read_json, write_json, verify_apk_signature
from tools.resource_pipeline.package_intake import inspect_apk
from tools.resource_pipeline.adapters.global_public import APK_HOSTS, APK_USER_AGENT

CERTIFICATE = 'bf683e367551a3f629b90e16a63b315af74e387bcc5d94f26dcd626e7eea3637'
APKSIG_SHA256 = '7ae2e5980c77d853e3513074ee7c822bbdcdcde1668889d17faa7fe8bc8aa821'


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
        _, _, binding = resolve_bundle_decoder(parsed, profile['clientVersion'])
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
    from tools.bundle_decoder import resolve_bundle_decoder
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
    _, _, binding = resolve_bundle_decoder(parsed, identity['versionName'])
    command_enum(parsed)
    # Actual resource decryption is checked by each extractor before publication.
    profile = {'schemaVersion': 1, 'apk': str(apk.resolve()), 'apkSha256': sha,
        'metadata': str(metadata.resolve()), 'metadataSha256': file_hash(metadata),
        'clientVersion': identity['versionName'], 'versionCode': identity['versionCode'],
        'packageName': identity['packageName'], 'certificateSha256': CERTIFICATE,
        'signatureVerified': True, 'bundleDecoderBindingSha256': binding, 'decoder': 'global-v39-paged-xor-66', 'gameplayVerified': False}
    write_json(profile_path, profile)
    return profile
