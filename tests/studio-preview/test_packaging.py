"""Boundary checks for copying an owned runtime, without fetching or patching wheels."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[2] / 'scripts/studio-preview/packaging/bundle.py'
spec = importlib.util.spec_from_file_location('preview_bundle', SOURCE)
bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bundle)


class PackagingTests(unittest.TestCase):
    def test_copy_refuses_external_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            (source / 'escape').symlink_to(root / 'external')
            with self.assertRaises(ValueError):
                bundle.copy_tree(source, root / 'copied')

    def test_copy_preserves_internal_links_and_omits_venv_injection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            (source / 'module.py').write_text('value = 1\n')
            (source / 'alias').symlink_to('module.py')
            (source / '_virtualenv.pth').write_text('import _virtualenv\n')
            bundle.copy_tree(source, root / 'copied')
            self.assertTrue((root / 'copied/alias').is_symlink())
            self.assertEqual((root / 'copied/alias').read_text(), 'value = 1\n')
            self.assertFalse((root / 'copied/_virtualenv.pth').exists())

    def test_copy_refuses_absolute_internal_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.mkdir()
            (source / 'module.py').write_text('value = 1\n')
            (source / 'absolute').symlink_to(source / 'module.py')
            with self.assertRaises(ValueError):
                bundle.copy_tree(source, root / 'copied')


if __name__ == '__main__':
    unittest.main()
