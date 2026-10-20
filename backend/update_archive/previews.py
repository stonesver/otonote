"""Offline, bounded previews. Inputs never execute in the workbench origin."""
from __future__ import annotations
import argparse
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from .models import ArchiveError, canonical, identity

PREVIEW_BYTES = 64 * 1024 ** 2
TEXT_LIMIT = 512 * 1024


def convert(raw, output, name, *, context=None):
    raw, output = Path(raw), Path(output)
    suffix = Path(name).suffix.lower()
    results = []
    with raw.open('rb') as stream:
        header = stream.read(8)
    def image(im, label):
        if len(results) >= 64 or im.width * im.height > 16_000_000:
            raise ArchiveError('preview_image_budget')
        im.thumbnail((2048, 2048))
        path = f'image-{len(results)}.webp'
        im.save(output / path, format='WEBP', quality=85)
        results.append({'path': path, 'name': label, 'mime': 'image/webp',
                        'width': im.width, 'height': im.height})
    if suffix in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 16_000_000
        with Image.open(raw) as im:
            image(im.convert('RGBA'), name)
    elif suffix in ('.json', '.txt', '.csv', '.yaml', '.yml', '.js', '.cs', '.lua', '.xml', '.bytes', '.md'):
        with raw.open('rb') as source:
            value = source.read(TEXT_LIMIT)
        text = value.decode('utf-8')
        if '\x00' in text:
            raise ArchiveError('unsupported_text_encoding')
        if suffix == '.json':
            try:
                text = json.dumps(json.loads(text), ensure_ascii=False, indent=2)
            except ValueError:
                pass
        (output / 'text.txt').write_text(text[:TEXT_LIMIT])
        results.append({'path': 'text.txt', 'name': name, 'mime': 'text/plain',
                        'truncated': raw.stat().st_size > TEXT_LIMIT})
    elif suffix == '.wav':
        import wave
        with wave.open(str(raw), 'rb') as source:
            channels, width, rate = source.getnchannels(), source.getsampwidth(), source.getframerate()
            if channels > 2 or width > 4 or not 0 < rate <= 96000:
                raise ArchiveError('unsupported_wave_parameters')
            frames = min(source.getnframes(), rate * 180, (PREVIEW_BYTES - 1024) // (channels * width))
            with wave.open(str(output / 'audio.wav'), 'wb') as out:
                out.setparams(source.getparams()); out.writeframes(source.readframes(frames))
        results.append({'path': 'audio.wav', 'name': name, 'mime': 'audio/wav'})
    elif suffix in ('.wav', '.ogg', '.mp3', '.m4a', '.aac', '.flac', '.acb', '.awb'):
        if not shutil.which('ffmpeg'):
            raise ArchiveError('audio_converter_unavailable')
        audio = raw
        if suffix in ('.acb', '.awb'):
            vgm = shutil.which('vgmstream-cli')
            if not vgm:
                raise ArchiveError('cri_converter_unavailable')
            audio = output / 'decoded.wav'
            command = [vgm, '-o', str(audio)]
            if os.environ.get('OURNOTES_CRI_KEY'):
                command += ['-k', os.environ['OURNOTES_CRI_KEY']]
            command.append(str(raw))
            done = subprocess.run(command, capture_output=True, timeout=35)
            if done.returncode or not audio.exists() or audio.stat().st_size > PREVIEW_BYTES:
                raise ArchiveError('cri_conversion_failed')
        done = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(audio),
            '-t', '180', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libopus', '-b:a', '48k',
            str(output / 'audio.ogg')], capture_output=True, timeout=45)
        if done.returncode:
            raise ArchiveError('audio_conversion_failed')
        if audio != raw:
            audio.unlink(missing_ok=True)
        results.append({'path': 'audio.ogg', 'name': name, 'mime': 'audio/ogg'})
    elif suffix == '.bin' and Path(name).name.startswith('Master'):
        from analysis.crypto.decrypt_master import decrypt_master_file
        keys = [bytes.fromhex(os.environ.get('OURNOTES_MASTER_' + k + '_HEX', '')) for k in ('SALT', 'KEY', 'IV')]
        decrypt_master_file(raw, output / 'master.json', salt=keys[0], key=keys[1], iv=keys[2])
        if (output / 'master.json').stat().st_size > TEXT_LIMIT:
            raise ArchiveError('preview_text_budget')
        results.append({'path': 'master.json', 'name': name, 'mime': 'application/json'})
    elif suffix == '.bundle' or header.startswith(b'UnityFS'):
        import UnityPy
        payload = raw.read_bytes()
        if not payload.startswith(b'UnityFS'):
            if not context or 'metadata' not in context:
                raise ArchiveError('decoder_context_missing')
            from analysis.crypto.inspect_il2cpp import MetadataV39
            from tools.bundle_decoder import resolve_bundle_decoder
            from analysis.crypto.decrypt_global_formal_scores import decrypt_header
            metadata = MetadataV39(Path(context['metadata']))
            key, seed, _ = resolve_bundle_decoder(metadata, context['clientVersion'], profile=context.get('profile'))
            payload = decrypt_header(payload, name, key, seed)
        env = UnityPy.load(payload)
        listing = []
        for index, obj in enumerate(env.objects):
            if index >= 1000:
                break
            listing.append({'type': obj.type.name, 'pathId': str(obj.path_id)})
            if obj.type.name in ('Texture2D', 'Sprite') and len(results) < 32:
                data = obj.read()
                image(data.image, str(getattr(data, 'm_Name', obj.path_id)))
            elif obj.type.name == 'TextAsset' and len(results) < 64:
                data = obj.read()
                value = data.m_Script
                value = value.encode('utf-8') if isinstance(value, str) else bytes(value)
                text = value[:TEXT_LIMIT].decode('utf-8')
                path = f'text-{len(results)}.txt'
                (output / path).write_text(text)
                results.append({'path': path, 'name': str(data.m_Name), 'mime': 'text/plain'})
        (output / 'objects.json').write_bytes(canonical(listing))
        results.append({'path': 'objects.json', 'name': '对象清单', 'mime': 'application/json'})
    else:
        raise ArchiveError('preview_unsupported')
    if sum(p.stat().st_size for p in output.iterdir()) > PREVIEW_BYTES:
        raise ArchiveError('preview_budget_exceeded')
    return results


def limited_child():
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    resource.setrlimit(resource.RLIMIT_FSIZE, (PREVIEW_BYTES, PREVIEW_BYTES))
    if sys.platform == 'linux':
        resource.setrlimit(resource.RLIMIT_AS, (1024 ** 3, 1024 ** 3))


def generate(repo, entry, *, clock=time.time, context=None, max_output_bytes=PREVIEW_BYTES):
    status, error = 'unsupported', None
    try:
        with tempfile.TemporaryDirectory(prefix='otonote-archive-preview-') as folder:
            root = Path(folder); output = root / 'out'; output.mkdir()
            raw = root / ('raw' + Path(entry['key']).suffix)
            with repo.reading(entry['id'], now=clock()) as live:
                if live.get('decoderContext') and not context:
                    for role, local in (('context_metadata', 'metadata.dat'), ('context_profile', 'profile.json')):
                        item = live['previews'][role]
                        with contextlib.closing(repo.bucket.open(item['key'])) as source:
                            value = source.read(item['size'] + 1)
                        from .models import digest
                        if len(value) != item['size'] or digest(value) != item['sha256']:
                            raise ArchiveError('context_identity_changed')
                        (root / local).write_bytes(value)
                    context = json.loads((root / 'profile.json').read_bytes())
                    context['metadata'] = str(root / 'metadata.dat')
                with contextlib.closing(repo.bucket.open(live['objectKey'])) as source, raw.open('wb') as out:
                    count = 0
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        count += len(chunk)
                        if count > live['size']:
                            raise ArchiveError('object_size_mismatch')
                        out.write(chunk)
            from .store import file_digest
            if count != live['size'] or file_digest(raw) != live['sha256']:
                raise ArchiveError('object_digest_mismatch')
            env = {k: v for k, v in os.environ.items() if k in ('PATH', 'LANG', 'TMPDIR',
                   'OURNOTES_CRI_KEY', 'OURNOTES_MASTER_SALT_HEX', 'OURNOTES_MASTER_KEY_HEX', 'OURNOTES_MASTER_IV_HEX')}
            command = [sys.executable, '-m', 'backend.update_archive.previews', '--input', str(raw),
                       '--output', str(output), '--name', entry['key']]
            if context:
                config = root / 'context.json'; config.write_bytes(canonical(context))
                command += ['--context', str(config)]
            result = subprocess.run(command, env=env, capture_output=True, timeout=90, preexec_fn=limited_child)
            if result.returncode:
                reason = 'preview_unsupported_or_failed'
                error_file = output / 'error.json'
                if error_file.is_file() and error_file.stat().st_size < 1024:
                    code = json.loads(error_file.read_bytes()).get('error')
                    if code in ('decoder_context_missing', 'audio_converter_unavailable', 'cri_converter_unavailable'):
                        reason = code
                raise ArchiveError(reason)
            rows = json.loads((output / 'manifest.json').read_bytes())
            used = 0
            for row in rows:
                path = output / row['path']
                if path.parent != output or path.is_symlink() or not path.is_file():
                    raise ArchiveError('invalid_preview_output')
                used += path.stat().st_size
                if used > min(PREVIEW_BYTES, max_output_bytes):
                    raise ArchiveError('preview_capacity_deferred')
                role = 'preview_' + identity([entry['sha256'], row['path'], 'v1'])[:16]
                repo.save(entry['id'], path, now=clock(), role=role, evict=False)
                def attach(s):
                    e = s['entries'][entry['id']]
                    if e['status'] == 'saved' and role in e.get('previews', {}):
                        e['previews'][role].update({k: v for k, v in row.items() if k != 'path'})
                repo.mutate(attach)
            status = 'ready'
    except (ArchiveError, OSError, ValueError, subprocess.SubprocessError) as exc:
        error = str(exc) if isinstance(exc, ArchiveError) else 'preview_unsupported_or_budget'
        if isinstance(exc, ArchiveError) and (any(word in str(exc) for word in ('capacity', 'busy'))
                or str(exc) in ('decoder_context_missing', 'audio_converter_unavailable', 'cri_converter_unavailable')):
            status = 'deferred'
    def finish(s):
        e = s['entries'].get(entry['id'])
        if e and e['status'] == 'saved':
            e.update(previewStatus=status, previewError=error)
    repo.mutate(finish)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--context')
    args = parser.parse_args()
    try:
        rows = convert(Path(args.input), Path(args.output), args.name,
                       context=json.loads(Path(args.context).read_bytes()) if args.context else None)
        (Path(args.output) / 'manifest.json').write_bytes(canonical(rows))
        return 0
    except Exception as exc:
        code = str(exc) if isinstance(exc, ArchiveError) else 'preview_parse_failed'
        if code not in ('decoder_context_missing', 'audio_converter_unavailable', 'cri_converter_unavailable'):
            code = 'preview_parse_failed'
        (Path(args.output) / 'error.json').write_bytes(canonical({'error': code}))
        return 1  # Never emit parser exceptions, paths, binary data or key material.


def bind_context(repo, entry, context, *, clock=time.time):
    """Persist decoder material with the original, inside the same capacity ledger."""
    if entry.get('decoderContext') or not context.get('metadata'):
        return
    batch = repo.state()[0]['batches'].get(entry.get('batch'), {})
    version = batch.get('observation', {}).get('clientVersion')
    if not version or context.get('clientVersion') != version:
        return
    metadata = Path(context['metadata'])
    if metadata.stat().st_size > 32 * 1024 ** 2:
        return
    try:
        repo.save(entry['id'], metadata, now=clock(), role='context_metadata', evict=False)
        with tempfile.NamedTemporaryFile() as out:
            out.write(canonical({'clientVersion': version, 'profile': context.get('profile')})); out.flush()
            repo.save(entry['id'], out.name, now=clock(), role='context_profile', evict=False)
        def attach(s):
            e = s['entries'][entry['id']]
            if e['status'] == 'saved':
                e['decoderContext'] = True
        repo.mutate(attach)
    except (ArchiveError, OSError):
        pass  # Raw success is independent; context is retried within the original window.


if __name__ == '__main__':
    raise SystemExit(main())
