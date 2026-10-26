"""Receipt drift and failed-rerun regressions for Preview host qualification."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from test_preparation import ROOT, prepare


spec = importlib.util.spec_from_file_location('installer_acceptance', ROOT / 'scripts/studio-preview/packaging/acceptance.py')
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


def macho_fixture(vm_size=4096, payload=b'unchanged-code!!'):
    header = struct.pack('<8I', 0xFEEDFACF, 0x100000C, 0, 2, 1, 72, 0, 0)
    segment = struct.pack('<II16sQQQQIIII', 0x19, 72, b'__LINKEDIT', 0x1000,
                          vm_size, 136, len(payload), 1, 1, 0, 0)
    return header + segment + b'\0' * 32 + payload


def signed_macho_fixture():
    data = bytearray(macho_fixture())
    data.extend(b'\0' * ((-len(data)) % 16))
    at = len(data)
    blob = struct.pack('>III', 0xFADE0CC0, 28, 1) + struct.pack('>II', 0, 20) + struct.pack('>II', 0xFADE0C02, 8)
    data.extend(blob)
    struct.pack_into('<II', data, 16, 2, 88)
    struct.pack_into('<II16sQQQQIIII', data, 32, 0x19, 72, b'__LINKEDIT', 0x1000, 8192, 136, len(data) - 136, 1, 1, 0, 0)
    struct.pack_into('<IIII', data, 104, 0x1D, 16, at, len(blob))
    return data


class ReceiptTests(unittest.TestCase):
    def test_forwarding_observers_support_unicode_paths_with_a_cp1252_locale(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        original_open = io.open

        def windows_open(file, mode='r', buffering=-1, encoding=None, errors=None,
                         newline=None, closefd=True, opener=None):
            if 'b' not in mode and encoding in (None, 'locale'):
                encoding = 'cp1252'
            return original_open(file, mode, buffering, encoding, errors, newline, closefd, opener)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '한글 경로'
            root.mkdir()
            payload = root / '설치 payload'
            with patch('io.open', side_effect=windows_open):
                with self.assertRaises(UnicodeEncodeError):
                    (root / 'locale-probe').write_text('한글')
                entry, native, _, _ = wire.observers(root, payload)
            for script in (entry, native):
                raw = script.read_bytes()
                compile(raw, str(script), 'exec')
                self.assertIn('한글 경로', raw.decode('utf-8'))
            self.assertIn(str(payload.resolve() / 'launch.py'), native.read_text(encoding='utf-8'))

    @unittest.skipUnless(shutil.which('node'), 'Node driver is required')
    def test_inventory_diagnostic_omits_extra_names_and_raw_resource_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            missing = 'managed-resources/node/node_modules/pkg/package.json'
            changed = 'managed-resources/node/node.exe'
            sentinel = 'SYNTHETIC_AUTH_PAYLOAD_MUST_NOT_APPEAR'
            (root / 'manifest.json').write_text(json.dumps({'inventory': {missing: 'missing-sha', changed: 'old-sha'}}))
            fixture = root / 'fixture.cjs'
            fixture.write_text("module.exports={verifyDefaultHostBundle(){throw Error('fixture mismatch')},inventory(){return "
                               + json.dumps({changed: sentinel, sentinel: 'extra-sha'}) + ";}}")
            output = root / 'diagnostic.json'
            result = subprocess.run(['node', '-e', acceptance.BUNDLE_VERIFIER, str(fixture), str(root),
                                     'win32-x64', str(output)], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            diagnostic = json.loads(output.read_text())
            self.assertEqual((diagnostic['missingCount'], diagnostic['changedCount'], diagnostic['extraCount']), (1, 1, 1))
            self.assertEqual(diagnostic['missingPublicPaths'], [missing])
            self.assertEqual(diagnostic['changedPublicPaths'], [changed])
            self.assertNotIn(sentinel, output.read_text())

    def test_signing_allocation_normalization_preserves_code_comparison(self):
        original = acceptance.macho_code_identity(macho_fixture())
        self.assertEqual(original, acceptance.macho_code_identity(macho_fixture(vm_size=8192)))
        self.assertNotEqual(original, acceptance.macho_code_identity(macho_fixture(payload=b'changed-code!!!!')))

    def test_macho_identity_refuses_truncated_or_missing_commands(self):
        for raw in (b'not-a-host', macho_fixture()[:40], macho_fixture().replace(b'__LINKEDIT', b'__NOTEDIT_')):
            with self.subTest(raw=raw[:8]), self.assertRaises(ValueError):
                acceptance.macho_code_identity(raw)

    def test_signature_normalization_retains_code_and_alignment_bytes(self):
        signed = signed_macho_fixture()
        expected = acceptance.macho_code_identity(macho_fixture())
        self.assertEqual(expected, acceptance.macho_code_identity(signed))
        signed[154] = 1
        self.assertNotEqual(expected, acceptance.macho_code_identity(signed))

    def test_signature_extent_and_index_are_not_trusted(self):
        for field, value in ((112, 144), (116, 9999), (160, 0), (184, 9999)):
            with self.subTest(field=field):
                data = signed_macho_fixture()
                struct.pack_into('<I', data, field, value)
                with self.assertRaises(ValueError):
                    acceptance.macho_code_identity(data)

    def test_modified_host_or_launcher_is_refused(self):
        for modified in ('core', 'launch.cjs', 'qualification.json', 'entrypoint'):
            with self.subTest(modified=modified), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                baseline = root / 'baseline.json'
                baseline.write_text('{}')
                for filename in ('core', 'launch.cjs', 'qualification.json', 'entrypoint'):
                    (root / filename).write_bytes(b'original')
                shutil.copy(ROOT / 'scripts/studio-preview/host-forwarding/launch.cjs', root / 'launch.cjs')
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

    def test_provider_preflight_failure_invalidates_both_old_receipts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scripts = root / 'scripts/studio-preview'
            scripts.mkdir(parents=True)
            for name in ('prepare.py', 'providerSmoke.py'):
                shutil.copy(ROOT / 'scripts/studio-preview' / name, scripts / name)
            output = root / '.local/studio-provider'
            output.mkdir(parents=True)
            for name in ('host.json', 'helper.json'):
                (output / name).write_text(json.dumps({'status': 'passed'}))
            result = subprocess.run([sys.executable, '-B', str(scripts / 'providerSmoke.py'),
                                     '--runtime', str(root / 'unprepared')], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual([json.loads((output / name).read_text())['status']
                              for name in ('host.json', 'helper.json')], ['failed', 'failed'])

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
