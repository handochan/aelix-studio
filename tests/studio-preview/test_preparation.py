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
    def test_standalone_selection_ignores_minor_version_alias(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'cpython-3.12.13-macos-aarch64-none'
            (installation / 'bin').mkdir(parents=True)
            (installation / 'bin/python3').write_text('owned interpreter')
            (root / 'cpython-3.12-macos-aarch64-none').symlink_to(installation, target_is_directory=True)
            self.assertEqual(prepare.managed_python(root), installation / 'bin/python3')

    def test_standalone_selection_refuses_ambiguous_installations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for version in ('3.12.12', '3.12.13'):
                (root / ('cpython-' + version)).mkdir()
            with self.assertRaisesRegex(ValueError, 'one owned standalone'):
                prepare.managed_python(root)

    def test_standalone_selection_refuses_external_interpreter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'cpython-fixture'
            (installation / 'bin').mkdir(parents=True)
            (installation / 'bin/python3').symlink_to(Path(__file__).resolve())
            with self.assertRaisesRegex(ValueError, 'escapes'):
                prepare.managed_python(root)

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
