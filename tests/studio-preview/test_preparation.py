"""Failure regressions for the disposable Preview preparation boundary."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

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
            self.assertEqual(prepare.managed_python(root, system='darwin'), installation / 'bin/python3')

    def test_standalone_selection_refuses_ambiguous_installations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for version in ('3.12.12', '3.12.13'):
                (root / ('cpython-' + version)).mkdir()
            with self.assertRaisesRegex(ValueError, 'one owned standalone'):
                prepare.managed_python(root, system='darwin')

    def test_standalone_selection_refuses_external_interpreter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'cpython-fixture'
            (installation / 'bin').mkdir(parents=True)
            (installation / 'bin/python3').symlink_to(Path(__file__).resolve())
            with self.assertRaisesRegex(ValueError, 'escapes'):
                prepare.managed_python(root, system='darwin')

    def test_windows_standalone_uses_owned_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / 'cpython-3.12.15-windows-x86_64-none'
            installation.mkdir()
            (installation / 'python.exe').write_bytes(b'owned executable')
            self.assertEqual(prepare.managed_python(root, system='win32'), installation / 'python.exe')

    def test_host_architecture_aliases_and_unsupported_platform(self):
        for system, machine, expected in (
                ('win32', 'AMD64', 'win32-x64'), ('linux', 'aarch64', 'linux-arm64'),
                ('darwin', 'arm64', 'darwin-arm64'), ('darwin', 'x86_64', 'darwin-x64')):
            with self.subTest(system=system, machine=machine):
                self.assertEqual(prepare.host_target(system, machine), expected)
        with self.assertRaisesRegex(ValueError, 'Unsupported host'):
            prepare.host_target('linux', 'i686')

    def test_zip_traversal_or_link_is_refused_before_writing(self):
        for name, mode in (('../escape', 0), ('C:escape', 0), ('folder\\escape', 0), ('link', 0o120777)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / 'source.zip'
                with zipfile.ZipFile(archive, 'w') as output:
                    output.writestr('safe.txt', b'safe')
                    member = zipfile.ZipInfo(name)
                    member.filename = name  # Preserve hostile raw separators on Windows too.
                    member.external_attr = mode << 16
                    output.writestr(member, b'unsafe')
                with self.assertRaisesRegex(ValueError, 'Unsafe archive'):
                    prepare.extract(archive, root / 'output')
                self.assertFalse((root / 'output/safe.txt').exists())

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
