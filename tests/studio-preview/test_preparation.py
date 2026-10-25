"""Failure regressions for the disposable Preview preparation boundary."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('preview_prepare', ROOT / 'scripts/studio-preview/prepare.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def test_cached_archive_with_wrong_digest_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'archive'
            target.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                prepare.download('https://unused.invalid', target, '0' * 64)

    def test_archive_traversal_is_refused_before_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'source.tar'
            with tarfile.open(archive, 'w') as output:
                for name in ('safe.txt', '../escaped.txt'):
                    member = tarfile.TarInfo(name)
                    member.size = 4
                    output.addfile(member, io.BytesIO(b'test'))
            with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                prepare.extract(archive, Path(temporary) / 'output')
            self.assertFalse((Path(temporary) / 'output/safe.txt').exists())

    def test_archive_link_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = Path(temporary) / 'source.tar'
            with tarfile.open(archive, 'w') as output:
                member = tarfile.TarInfo('link')
                member.type = tarfile.SYMTYPE
                member.linkname = '/tmp/elsewhere'
                output.addfile(member)
            with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                prepare.extract(archive, Path(temporary) / 'output')



if __name__ == '__main__':
    unittest.main()
