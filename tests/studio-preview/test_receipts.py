"""Receipt drift and failed-rerun regressions for Preview host qualification."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from test_preparation import ROOT, prepare


class ReceiptTests(unittest.TestCase):
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
