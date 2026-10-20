"""Bounded APK members; identity and signatures checked before inventory."""
import hashlib
from pathlib import Path
import stat
import zipfile
from ..models import ArchiveError, file_record, safe_name
from ..store import file_digest


def members(path, *, max_total=2 * 1024 ** 3, max_member=256 * 1024 ** 2):
    result, seen, total = [], set(), 0
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 100000:
            raise ArchiveError('package_too_many_entries')
        for item in archive.infolist():
            if item.is_dir():
                continue
            safe_name(item.filename)
            if item.filename in seen or stat.S_ISLNK(item.external_attr >> 16):
                raise ArchiveError('unsafe_package_member')
            seen.add(item.filename)
            total += item.file_size
            if (total > max_total or item.file_size > max_member
                    or item.file_size > max(1, item.compress_size) * 1000):
                raise ArchiveError('package_expansion_exceeded')
            h = hashlib.sha256()
            with archive.open(item) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(chunk)
            result.append((item.filename, item.file_size, h.hexdigest()))
    return result


class VerifiedPackages:
    def __init__(self, selected_region, packages, apksig):
        self.region, self.packages, self.apksig = selected_region, packages, Path(apksig)
        self.verified = {}

    def inventory(self, version):
        from tools.global_remote_sync import verify_apk_signature
        from tools.resource_pipeline.package_intake import inspect_apk
        if self.region == 'global':
            from tools.current_client import CERTIFICATE, APKSIG_SHA256
            certificate, jar_sha = CERTIFICATE, APKSIG_SHA256
            package_names = ('com.bilibili.sirius', 'com.bilibili.sirius.official')
        else:
            from tools.jp_phone_inputs import JP_CERTIFICATE_SHA256, JP_APKSIG_SHA256
            certificate, jar_sha = JP_CERTIFICATE_SHA256, JP_APKSIG_SHA256
            package_names = ('com.bushiroad.sirius',)
        if file_digest(self.apksig) != jar_sha:
            raise ArchiveError('unverified_signature_tool')
        if not self.packages or len(self.packages) > 16:
            raise ArchiveError('invalid_package_set')
        rows, facts_set, total = [], [], 0
        for package in self.packages:
            path = Path(package['path'])
            if path.is_symlink() or file_digest(path) != package['sha256']:
                raise ArchiveError('package_digest_mismatch')
            total += path.stat().st_size
            if total > 512 * 1024 ** 2:
                raise ArchiveError('package_budget_exceeded')
            facts = inspect_apk(path)
            facts_set.append(facts)
            if (facts.get('versionName') not in (None, '', version)
                    or not facts.get('splitName') and facts.get('versionName') != version) or facts['packageName'] not in package_names or facts['certificateSha256'] != certificate:
                raise ArchiveError('package_identity_mismatch')
            verify_apk_signature(path, self.apksig, certificate)
            logical = safe_name(facts.get('splitName') or 'base')
            self.verified[package['sha256']] = path
            for name, size, sha in members(path):
                rows.append(file_record({'source': 'client_entry', 'key': logical + '/' + name,
                    'path': name, 'package': package['sha256'], 'size': size,
                    'sha256': sha, 'hashAlgorithm': 'sha256'}))
        versions = {f.get('versionCode') for f in facts_set}
        splits = [f.get('splitName') or 'base' for f in facts_set]
        if len({f['packageName'] for f in facts_set}) != 1 or len(versions) != 1 or len(set(splits)) != len(splits) or 'base' not in splits:
            raise ArchiveError('incoherent_package_set')
        if self.region == 'jp' and not {'UnityDataAssetPack', 'config.arm64_v8a'} <= set(splits):
            raise ArchiveError('incomplete_jp_package_set')
        return rows

    def fetch(self, record, target):
        path = self.verified.get(record['package'])
        if not path or file_digest(path) != record['package']:
            raise ArchiveError('historical_package_unavailable')
        with zipfile.ZipFile(path) as archive, archive.open(record['path']) as stream, Path(target).open('xb') as out:
            count = 0
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                count += len(chunk)
                if count > record['size']:
                    raise ArchiveError('package_member_size_mismatch')
                out.write(chunk)
