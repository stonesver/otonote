import tempfile
import unittest
from pathlib import Path
from PIL import Image
from backend.update_archive.previews import convert


class PreviewTests(unittest.TestCase):
    def test_image_becomes_bounded_webp_and_script_stays_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = root / 'image.png'
            Image.new('RGBA', (16, 32), (20, 40, 60, 100)).save(raw)
            out = root / 'out'; out.mkdir()
            result = convert(raw, out, 'image.png')
            self.assertEqual(result[0]['mime'], 'image/webp')
            with Image.open(out / result[0]['path']) as image:
                self.assertEqual(image.size, (16, 32))
            raw = root / 'code.js'; raw.write_text('<script>alert(1)</script>')
            result = convert(raw, out, 'code.js')
            self.assertEqual(result[0]['mime'], 'text/plain')

    def test_wave_preview_is_available_without_external_converter(self):
        import wave
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);raw=root/'a.wav';out=root/'out';out.mkdir()
            with wave.open(str(raw),'wb') as audio:
                audio.setparams((1,2,8000,0,'NONE','not compressed'));audio.writeframes(b'\0\0'*8000)
            with patch('backend.update_archive.previews.shutil.which',return_value=None):
                rows=convert(raw,out,'a.wav')
            self.assertEqual(rows[0]['mime'],'audio/wav')
            with wave.open(str(out/'audio.wav')) as audio:self.assertEqual(audio.getnframes(),8000)

    def test_external_audio_conversion_produces_valid_ogg_when_available(self):
        import shutil,wave
        if not shutil.which('ffmpeg'):self.skipTest('ffmpeg unavailable; WAV fallback is covered separately')
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);raw=root/'a.wav';out=root/'out';out.mkdir()
            with wave.open(str(raw),'wb') as audio:
                audio.setparams((1,2,8000,0,'NONE','not compressed'));audio.writeframes(b'\0\0'*8000)
            rows=convert(raw,out,'audio.m4a')
            self.assertEqual(rows[0]['mime'],'audio/ogg')
            self.assertTrue((out/'audio.ogg').read_bytes().startswith(b'OggS'))

    def test_missing_decoder_context_waits_for_later_run_without_losing_original(self):
        import time
        from backend.update_archive.previews import generate
        from backend.update_archive.store import ArchiveRepository,LocalBucket
        with tempfile.TemporaryDirectory() as root:
            repo=ArchiveRepository(LocalBucket(root));now=time.time()
            eid=repo.add('global','future.bundle',b'encrypted synthetic bundle',observed_at=now,now=now)
            generate(repo,repo.entry(eid))
            e=repo.entry(eid)
            self.assertEqual(e['status'],'saved')
            self.assertEqual(e['previewStatus'],'deferred')
            self.assertEqual(e['previewError'],'decoder_context_missing')
            self.assertEqual(repo.content(eid),b'encrypted synthetic bundle')
