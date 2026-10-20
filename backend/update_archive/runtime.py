"""Archive-owned source construction; checkpoint access is strictly GET-only."""
import contextlib
import json
from pathlib import Path
import shutil
import tempfile

from .bootstrap import restore_materials
from .config import s3_client
from .models import ArchiveError, region, safe_name


@contextlib.contextmanager
def source(config, selected_region):
    region(selected_region)
    settings = config.get('sources', {}).get(selected_region)
    if not isinstance(settings, dict):
        raise ArchiveError('archive_source_configuration_required')
    with tempfile.TemporaryDirectory(prefix='otonote-archive-materials-') as folder:
        root = Path(folder)
        received = 0
        if settings.get('checkpoint'):
            spec = settings['checkpoint']
            restored = restore_materials(s3_client(spec.get('envPrefix', 'OURNOTES_ARCHIVE_SOURCE')),
                spec['bucket'], selected_region, spec.get('selection'), root, preset=spec.get('preset'))
            received = restored['receivedBytes']
        else:
            # Local inputs must be explicit, immutable copies, never shared mutable state.
            total = 0
            for name, value in settings.get('materials', {}).items():
                safe_name(name)
                p = Path(value)
                if p.is_symlink() or not p.is_file():
                    raise ArchiveError('invalid_local_material')
                total += p.stat().st_size
                if total > 512 * 1024 ** 2:
                    raise ArchiveError('bootstrap_budget_exceeded')
                out = root / name; out.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(p, out)
        def material(key):
            value = settings.get(key)
            if value is None:
                return None
            safe_name(value)
            p = root / value
            if not p.is_file():
                raise ArchiveError('archive_material_missing')
            return str(p)
        version = settings.get('clientVersion')
        if settings.get('versionFile'):
            proof = json.loads(Path(material('versionFile')).read_bytes())
            version = proof.get('clientVersion') or proof.get('observation', {}).get('clientVersion')
        if selected_region == 'global':
            from tools.resource_pipeline.adapters.global_public import GlobalPublicClient
            from .sources.global_source import GlobalSource
            adapter = GlobalSource(GlobalPublicClient(version))
        else:
            from tools.jp_remote_sync import client_from_metadata
            from .sources.jp_source import JpSource
            adapter = JpSource(client_from_metadata(material('metadata'), authorize_builtin_credentials=True))
        if settings.get('packages'):
            from .sources.client_entries import VerifiedPackages
            packages = []
            for item in settings['packages']:
                safe_name(item['file'])
                packages.append({'path': str(root / item['file']), 'name': item['name'], 'sha256': item['sha256']})
            adapter.packages = VerifiedPackages(selected_region, packages, material('apksig'))
        adapter.received_bytes = received
        adapter.context = {'metadata': material('metadata'), 'clientVersion': adapter.client.client_version}
        if material('profile'):
            profile = json.loads(Path(material('profile')).read_bytes())
            # Current production decoder receipts carry the selected profile.
            # Preview decoding still verifies its exact version/metadata digest.
            adapter.context['profile'] = profile.get('bundleDecoderProfile', profile)
        yield adapter


@contextlib.contextmanager
def hide_storage_environment(config, selected_region):
    """SDK clients already own explicit credentials; parser/curl/Java children don't."""
    import os
    prefixes = {'AWS_', 'R2_', 'OURNOTES_ARCHIVE_'}
    storage = config.get('storage', {})
    checkpoint = config.get('sources', {}).get(selected_region, {}).get('checkpoint', {})
    for settings in (storage, checkpoint):
        prefix = settings.get('envPrefix')
        if isinstance(prefix, str):
            prefixes.add(prefix + '_')
    removed = {k: v for k, v in os.environ.items() if any(k.startswith(p) for p in prefixes)}
    try:
        for k in removed:
            os.environ.pop(k, None)
        yield
    finally:
        os.environ.update(removed)


class PreparedSource:
    """Construct network/material adapters only after the worker admits its run."""
    def __init__(self, config, selected_region, stack):
        self.config, self.region, self.stack = config, selected_region, stack
        self.adapter = None

    def snapshot(self, previous=None):
        self.adapter = self.stack.enter_context(source(self.config, self.region))
        self.stack.enter_context(hide_storage_environment(self.config, self.region))
        return self.adapter.snapshot(previous=previous)

    def fetch(self, row, target):
        return self.adapter.fetch(row, target)

    def __getattr__(self, name):
        return getattr(self.adapter, name)
