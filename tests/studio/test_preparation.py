"""Fail closed on adapter drift or corrupted runtime bytes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = load('studio_smoke', ROOT / 'scripts/aelix-studio/smokeRuntime.py')
prepare = load('studio_prepare', ROOT / 'scripts/aelix-studio/prepareRuntime.py')
launcher = load('studio_launcher', ROOT / 'scripts/aelix-studio/runtimeLauncher.py')


class PreparationTests(unittest.TestCase):
    def test_minor_version_directory_alias_is_not_a_second_python_installation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            actual = root/'cpython-3.12.12-windows-x86_64-none'
            actual.mkdir()
            # A junction is reported as a directory, not a symlink, by pathlib on Windows.
            (root/'cpython-3.12-windows-x86_64-none').mkdir()
            self.assertEqual(prepare.managed_python(root, '3.12.12'), actual)

    def test_wrong_python_version_cannot_be_moved_into_the_runtime(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp)/'cpython-3.12.13-windows-x86_64-none').mkdir()
            with self.assertRaisesRegex(RuntimeError, 'exactly one'):
                prepare.managed_python(tmp, '3.12.12')

    def test_ambiguous_exact_python_installations_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            for arch in ('x86_64', 'aarch64'):
                (Path(tmp)/f'cpython-3.12.12-windows-{arch}-none').mkdir()
            with self.assertRaises(RuntimeError):
                prepare.managed_python(tmp, '3.12.12')

    def test_analytics_seeds_a_private_cache_without_modifying_the_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)/'bundle'
            (root/'analytics-cache').mkdir(parents=True)
            (root/'analytics-cache/wheel').write_text('locked wheel')
            (root/'manifest.json').write_text(json.dumps({'analyticsLockSha256': 'a' * 64}))
            state = Path(tmp)/'data/acp/analytics'
            environment = launcher.analytics_environment(root, state)
            cache = Path(environment['UV_CACHE_DIR'])
            self.assertTrue(cache.is_relative_to((Path(tmp)/'data').resolve()))
            self.assertEqual((cache/'wheel').read_text(), 'locked wheel')
            (cache/'wheel').write_text('private cache update')
            launcher.analytics_environment(root, state)
            self.assertEqual((cache/'wheel').read_text(), 'private cache update')
            self.assertEqual((root/'analytics-cache/wheel').read_text(), 'locked wheel')
            self.assertEqual(environment['UV_PYTHON_DOWNLOADS'], 'never')

    def test_invalid_cache_receipt_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'manifest.json').write_text(json.dumps({'analyticsLockSha256': '../escape'}))
            with self.assertRaises(RuntimeError):
                launcher.analytics_environment(root, root/'state')

    def test_cache_target_cannot_escape_app_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'manifest.json').write_text(json.dumps({'analyticsLockSha256': 'a' * 64, 'target': '../escape'}))
            with self.assertRaises(RuntimeError):
                launcher.analytics_environment(root, root/'state')

    def test_inventory_detects_tampering_and_missing_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'launch.py').write_text('original')
            inventory = {'launch.py': hashlib.sha256(b'original').hexdigest()}
            (root / 'checksums.json').write_text(json.dumps(inventory))
            smoke.verify_inventory(root)
            (root / 'launch.py').write_text('changed')
            with self.assertRaisesRegex(RuntimeError, 'inventory mismatch'):
                smoke.verify_inventory(root)
            (root / 'launch.py').unlink()
            with self.assertRaisesRegex(RuntimeError, 'inventory mismatch'):
                smoke.verify_inventory(root)


if __name__ == '__main__':
    unittest.main()
