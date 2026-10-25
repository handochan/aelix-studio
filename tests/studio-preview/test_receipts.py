"""Receipt drift and failed-rerun regressions for Preview host qualification."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import struct
import sys
import tempfile
import unittest

from test_preparation import ROOT, prepare


spec = importlib.util.spec_from_file_location('installer_acceptance', ROOT / 'scripts/studio-preview/packaging/acceptance.py')
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


def macho_fixture(vm_size=4096, payload=b'unchanged-code!!'):
    header = struct.pack('<8I', 0xFEEDFACF, 0x100000C, 0, 2, 1, 72, 0, 0)
    segment = struct.pack('<II16sQQQQIIII', 0x19, 72, b'__LINKEDIT', 0x1000,
                          vm_size, 104, len(payload), 1, 1, 0, 0)
    return header + segment + payload


class ReceiptTests(unittest.TestCase):
    def test_signing_allocation_normalization_preserves_code_comparison(self):
        original = acceptance.unsigned_macho_identity(macho_fixture())
        self.assertEqual(original, acceptance.unsigned_macho_identity(macho_fixture(vm_size=8192)))
        self.assertNotEqual(original, acceptance.unsigned_macho_identity(macho_fixture(payload=b'changed-code!!!!')))

    def test_macho_identity_refuses_truncated_or_missing_commands(self):
        for raw in (b'not-a-host', macho_fixture()[:40], macho_fixture().replace(b'__LINKEDIT', b'__NOTEDIT_')):
            with self.subTest(raw=raw[:8]), self.assertRaises(ValueError):
                acceptance.unsigned_macho_identity(raw)

    def test_modified_host_or_launcher_is_refused(self):
        for modified in ('core', 'launch.cjs', 'qualification.json', 'entrypoint'):
            with self.subTest(modified=modified), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                baseline = root / 'baseline.json'
                baseline.write_text('{}')
                for filename in ('core', 'launch.cjs', 'qualification.json', 'entrypoint'):
                    (root / filename).write_bytes(b'original')
                shutil.copy(ROOT / 'scripts/studio-preview/launch.cjs', root / 'launch.cjs')
                original = hashlib.sha256(b'original').hexdigest()
                receipt = dict(baselineSha256=prepare.digest(baseline), aioncoreBinary='core',
                               aioncoreBinarySha256=original, launcherSha256=prepare.digest(root / 'launch.cjs'),
                               qualificationSha256=original, entrypointSha256={'entrypoint': original})
                (root / 'receipt.json').write_text(json.dumps(receipt))
                prepare.verify_prepared(root, baseline)
                (root / modified).write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'bytes changed'):
                    prepare.verify_prepared(root, baseline)

    def test_stale_baseline_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'baseline.json').write_text('{}')
            (root / 'receipt.json').write_text(json.dumps({'baselineSha256': '0' * 64}))
            with self.assertRaisesRegex(ValueError, 'different baseline'):
                prepare.verify_prepared(root, root / 'baseline.json')

    def test_failed_optimized_rerun_replaces_an_old_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scripts = root / 'scripts/studio-preview'
            scripts.mkdir(parents=True)
            for name in ('prepare.py', 'smoke.py'):
                shutil.copy(ROOT / 'scripts/studio-preview' / name, scripts / name)
            runtime = root / '.local/studio-preview'
            runtime.mkdir(parents=True)
            report = runtime / 'host-smoke.json'
            report.write_text(json.dumps({'status': 'passed'}))
            result = subprocess.run([sys.executable, '-O', '-B', str(scripts / 'smoke.py')],
                                    capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(report.read_text())['status'], 'failed')


if __name__ == '__main__':
    unittest.main()
