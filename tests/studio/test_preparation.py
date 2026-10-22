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


patcher = load('studio_patcher', ROOT / 'scripts/aelix-studio/compatibility/apply.py')
smoke = load('studio_smoke', ROOT / 'scripts/aelix-studio/smokeRuntime.py')


class PreparationTests(unittest.TestCase):
    def test_upstream_contract_drift_aborts_patching(self):
        with self.assertRaisesRegex(RuntimeError, 'contract changed'):
            patcher.replace_once('changed upstream source', 'expected code', 'replacement')

    def test_ambiguous_patch_is_rejected(self):
        with self.assertRaises(RuntimeError):
            patcher.replace_once('code code', 'code', 'replacement')

    def test_matching_contract_can_be_patched(self):
        self.assertEqual(patcher.replace_once('old code', 'old', 'new'), 'new code')

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
