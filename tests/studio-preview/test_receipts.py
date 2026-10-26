"""Receipt drift and failed-rerun regressions for Preview host qualification."""
import ast
import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
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
    def test_forwarding_terminal_receipt_does_not_replace_runtime_readiness(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_idle', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        idle = dict(state='idle', can_send_message=True, is_processing=False,
                    pending_confirmations=0, turn_id=None)
        observations = [dict(idle, state='running', turn_id='original-turn'),
                        dict(idle, can_send_message=False),
                        dict(idle, is_processing=True),
                        dict(idle, pending_confirmations=1),
                        dict(idle, turn_id='original-turn'), idle]
        calls = []

        async def api(path, method='GET'):
            calls.append((path, method))
            return 200, dict(operation={'state': 'completed'}, runtime=observations.pop(0))

        asyncio.run(wire.wait_runtime_idle(api, '/api/conversations/original', timeout=1))
        self.assertFalse(observations)
        self.assertEqual(calls, [('/api/conversations/original', 'GET')] * 6)

    def test_forwarding_runtime_readiness_times_out_without_a_replacement_post(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_idle_timeout', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        calls = []

        async def api(path, method='GET'):
            calls.append((path, method))
            return 200, dict(runtime={'state': 'running', 'turn_id': 'original-turn'})

        with self.assertRaises(TimeoutError):
            asyncio.run(wire.wait_runtime_idle(api, '/api/conversations/original', timeout=0.05))
        self.assertTrue(calls)
        self.assertTrue(all(call == ('/api/conversations/original', 'GET') for call in calls))

    def test_owned_fixture_cleanup_retries_only_transient_windows_sharing_violations(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_cleanup', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        sharing_violation = PermissionError('synthetic owned file is closing')
        sharing_violation.winerror = 32
        with tempfile.TemporaryDirectory() as parent:
            directory = tempfile.TemporaryDirectory(dir=parent)
            owned = Path(directory.name)
            original_cleanup = directory.cleanup
            calls = []

            def closing_store():
                calls.append(True)
                if len(calls) < 3:
                    raise sharing_violation
                original_cleanup()

            with patch.object(directory, 'cleanup', closing_store), patch.object(wire.time, 'sleep'):
                wire.cleanup_owned_temporary_directory(directory)
            self.assertEqual(len(calls), 3)
            self.assertFalse(owned.exists())

        for error, timeout in ((sharing_violation, 0), (PermissionError('access denied'), 10)):
            with self.subTest(error=error, timeout=timeout), tempfile.TemporaryDirectory() as parent:
                directory = tempfile.TemporaryDirectory(dir=parent)
                try:
                    with patch.object(directory, 'cleanup', side_effect=error) as cleanup:
                        with self.assertRaises(PermissionError):
                            wire.cleanup_owned_temporary_directory(directory, timeout=timeout)
                        cleanup.assert_called_once()
                    self.assertTrue(Path(directory.name).exists())
                finally:
                    directory.cleanup()

    def test_forwarding_observers_support_unicode_paths_with_a_cp1252_locale(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        original_write_text = Path.write_text

        def windows_write_text(path, data, encoding=None, errors=None):
            # Emulate the default at the call boundary, before Python's own
            # UTF-8 mode can normalize an omitted encoding into UTF-8.
            return original_write_text(path, data, encoding=encoding or 'cp1252', errors=errors)

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '한글 경로'
            root.mkdir()
            payload = root / r'설치 payload\nested'
            with patch.object(Path, 'write_text', windows_write_text):
                with self.assertRaises(UnicodeEncodeError):
                    (root / 'locale-probe').write_text('한글')
                entry, native, _, _ = wire.observers(root, payload)
            for script in (entry, native):
                raw = script.read_bytes()
                compile(raw, str(script), 'exec')
                self.assertIn('한글 경로', raw.decode('utf-8'))
            tree = ast.parse(native.read_text(encoding='utf-8'))
            literals = [node.value for node in ast.walk(tree)
                        if isinstance(node, ast.Constant) and isinstance(node.value, str)]
            self.assertEqual(literals.count(str(payload.resolve() / 'launch.py')), 2)

    def test_forwarding_startup_events_and_diagnostics_are_bounded(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_startup', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        secret = 'SYNTHETIC_STARTUP_SECRET_MUST_NOT_APPEAR'
        event = b'AIONCORE_LISTENING {"host":"127.0.0.1","port":54321}\n'
        self.assertIsNone(wire.listening_port(event[:-1]))
        self.assertEqual(wire.listening_port(event), 54321)
        for payload in ({'host': 'external.example', 'port': 54321},
                        {'host': '127.0.0.1', 'port': True},
                        {'host': '127.0.0.1', 'port': 65536}):
            with self.assertRaisesRegex(RuntimeError, '^Invalid owned host listening event$'):
                wire.listening_port(b'AIONCORE_LISTENING ' + json.dumps(payload).encode() + b'\n')
        previous = event + b'AIONCORE_READY\n'
        current = (secret + '\nBOOTSTRAP_BIND_FAILED\n').encode()
        diagnostic = wire.startup_diagnostics((previous + current)[len(previous):], 3, 'crash_restart')
        self.assertTrue(diagnostic['bindFailed'])
        self.assertFalse(diagnostic['listeningObserved'])
        self.assertFalse(diagnostic['readyObserved'])
        self.assertEqual(diagnostic['returncode'], 3)
        self.assertNotIn(secret, json.dumps(diagnostic))
        self.assertEqual(wire.startup_diagnostics(current, secret, secret)['phase'], 'unknown')
        self.assertIsNone(wire.startup_diagnostics(current, secret, secret)['returncode'])

    def test_live_database_snapshot_detects_committed_wal_only_secret(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_snapshot', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        secret = b'SYNTHETIC_REVERSE_SECRET'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'aionui-backend.db'
            connection = sqlite3.connect(database)
            try:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('PRAGMA wal_autocheckpoint=0')
                connection.execute('CREATE TABLE proof(value BLOB)')
                connection.commit()
                self.assertEqual(wire.verify_live_database_snapshots(root, secret), 1)
                connection.execute('INSERT INTO proof VALUES(?)', (secret,))
                connection.commit()
                self.assertNotIn(secret, database.read_bytes())
                with self.assertRaisesRegex(AssertionError, '^Reverse payload persisted in live host database snapshot$'):
                    wire.verify_live_database_snapshots(root, secret)
            finally:
                connection.close()

    def test_live_database_snapshot_deadline_and_lock_fail_closed(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_snapshot_deadline', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            connection = sqlite3.connect(root / 'aionui-backend.db')
            try:
                connection.execute('CREATE TABLE proof(value TEXT)')
                connection.commit()
                with self.assertRaises(TimeoutError):
                    wire.verify_live_database_snapshots(root, b'SENTINEL', timeout=0)
                connection.execute('BEGIN EXCLUSIVE')
                with self.assertRaises((TimeoutError, sqlite3.OperationalError)):
                    wire.verify_live_database_snapshots(root, b'SENTINEL', timeout=0.05)
            finally:
                connection.close()

    def test_quiescent_scan_refuses_disappearing_logs_with_sidecar_suffixes(self):
        wire_spec = importlib.util.spec_from_file_location(
            'forwarding_wire_sidecars', ROOT / 'scripts/studio-preview/host-forwarding/wire.py')
        wire = importlib.util.module_from_spec(wire_spec)
        wire_spec.loader.exec_module(wire)
        database = Path('owned/data/aionui-backend.db')
        sidecar = Path(str(database) + '-wal')
        after = {database}
        self.assertEqual(wire.removed_database_sidecars(after | {sidecar}, after, {database}), {sidecar})
        for suffix in ('-wal', '-shm', '-journal'):
            log = Path('owned/logs') / ('ordinary-log' + suffix)
            with self.assertRaisesRegex(AssertionError, '^Unscanned non-sidecar persistence file disappeared$'):
                wire.removed_database_sidecars(after | {log}, after, {database})

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
