"""Receipt drift and failed-rerun regressions for Preview host qualification."""
import ast
import asyncio
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_preparation import ROOT, prepare


spec = importlib.util.spec_from_file_location('installer_acceptance', ROOT / 'scripts/studio-preview/packaging/acceptance.py')
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)

compact_probe_spec = importlib.util.spec_from_file_location(
    'compact_before_rules', ROOT / 'tests/manual/aelixCompactBeforeRules.py')
compact_probe = importlib.util.module_from_spec(compact_probe_spec)
compact_probe_spec.loader.exec_module(compact_probe)


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
    def test_compact_probe_reports_a_separately_supplied_checkout_without_attesting_the_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime = Path(temporary)
            stale_host = runtime / 'previous-build'
            stale_host.write_bytes(b'bytes from a previous build')
            baseline = json.loads((ROOT / 'scripts/studio-preview/baseline.json').read_text())
            (runtime / 'receipt.json').write_text(json.dumps({'native': baseline['native']}))
            args = ['probe', '--host', str(stale_host), '--host-source', str(runtime / 'next-checkout'),
                    '--runtime', str(runtime), '--acp-source', str(runtime / 'acp')]
            output = io.StringIO()
            with (patch.object(sys, 'argv', args),
                  patch.object(compact_probe, 'checkout_head', side_effect=['next-commit', 'acp-commit']),
                  patch.object(compact_probe, 'loopback_provider', return_value=contextlib.nullcontext((0, []))),
                  patch.object(compact_probe, 'start_host', return_value=contextlib.nullcontext()) as start,
                  patch.object(compact_probe, 'verify_cases'), contextlib.redirect_stdout(output)):
                compact_probe.main()
            evidence = json.loads(output.getvalue())
            self.assertEqual(start.call_args.args[0], stale_host.resolve())
            self.assertEqual(evidence['providedHostCheckoutSha'], 'next-commit')
            self.assertEqual(evidence['hostBinarySha256'], hashlib.sha256(stale_host.read_bytes()).hexdigest())
            self.assertEqual(evidence['hostBinaryBuildProvenance'], 'unverified')
            self.assertNotIn('host', evidence)

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
                shutil.copy(ROOT / 'scripts/studio-preview/host-release/launch.cjs', root / 'launch.cjs')
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




class FailedAuditReceiptTests(unittest.TestCase):
    def test_completed_failed_audit_evidence_survives_the_mandatory_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)/'acceptance.json'
            current = {'status':'failed','failedAudits':['provider'], 'auditedSessions':[{'name':'provider','status':'failed'}]}
            output.write_text(json.dumps(current))
            acceptance.write_failure_receipt(output)
            self.assertEqual(json.loads(output.read_text()),current)

    def test_recapture_history_survives_an_interrupted_final_acceptance(self):
        for status in ('failed','passed'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                root=Path(directory);output=root/'acceptance.json'
                audits=acceptance.AuditedSessions(root/'host',root/'python',root)
                audits.sessions=[dict(name='provider',status=status,recaptures=1,
                    captureAttempts=[{'attempt':1,'outcome':'evidence_incomplete'}, {'attempt':2,'status':'running'}])]
                acceptance.preserve_recapture_failure(output,audits,'linux-x64')
                acceptance.write_failure_receipt(output)
                saved=json.loads(output.read_text())
                self.assertEqual((saved['status'],saved['outboundRecaptures']),('failed',1))
                self.assertEqual(saved['recapturedAudits'],['provider'])
                self.assertEqual(len(saved['auditedSessions'][0]['captureAttempts']),2)

    def test_extension_failure_preserves_the_completed_smoke_verdict_and_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'acceptance.json'
            smoke = dict(status='passed', failedAudits=[], permissionChecks=25,
                         auditedSessions=[dict(name='permission', status='passed')],
                         outboundControls=[dict(name='positive-control', status='passed')],
                         auditedSessionsSha256='smoke-evidence')
            audits = acceptance.AuditedSessions(root/'host', root/'python', root, ledger='outbound-extensions-sessions.json')
            audits.enabled = True

            def fail_extension(receipt):
                checkpoint = json.loads(output.read_text())
                self.assertEqual((checkpoint['status'], checkpoint['smokeStatus']), ('running', 'passed'))
                self.assertEqual(checkpoint['outboundControls'], smoke['outboundControls'])
                receipt.write_text('{"status": "passed"}')
                audits.sessions.append(dict(name='extensions', status='failed', unparsedRecords=2))
                audits.save()
                raise RuntimeError('incomplete extension audit')

            with self.assertRaisesRegex(RuntimeError, 'incomplete extension audit'):
                acceptance.record_extension_qualification(smoke, output, audits, fail_extension)
            acceptance.write_failure_receipt(output)
            saved = json.loads(output.read_text())
            self.assertEqual((saved['status'], saved['smokeStatus']), ('failed', 'passed'))
            self.assertEqual(saved['auditedSessionsSha256'], 'smoke-evidence')
            self.assertEqual(saved['permissionChecks'], 25)
            self.assertEqual(saved['outboundControls'], [dict(name='positive-control', status='passed')])
            self.assertEqual(saved['failedAudits'], ['extensions'])
            extension = saved['extensionQualification']
            self.assertEqual(extension['status'], 'failed')
            self.assertEqual(extension['audit']['unparsedRecords'], 2)
            self.assertEqual((extension['captureTimeoutSeconds'], extension['totalTimeoutSeconds']), (180, 540))
            self.assertEqual(extension['timeoutScope'], 'audit-supervisor')
            self.assertTrue(extension['bundleInventoryOutsideTimeout'])
            self.assertGreaterEqual(extension['elapsedSeconds'], 0)

    def test_installer_start_clears_only_stale_extension_receipts_and_snapshots(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            permission = root / 'permission'
            permission.mkdir()
            extension_files = [
                root / 'extensions-qualification.json',
                permission / 'outbound-extensions-sessions.json',
                *(permission / (name + suffix) for name in ('outbound-extensions', 'outbound-app-extensions')
                  for suffix in ('.json', '.capture-1.json', '.capture-2.json')),
            ]
            smoke = permission / 'outbound.capture-2.json'
            for file in (*extension_files, smoke):
                file.write_text('old evidence')
            args = Mock(runtime=str(root/'runtime'), output=str(root/'acceptance.json'),
                        artifact=None, dmg=None, artifacts=str(root/'missing'))
            with self.assertRaises(ValueError):
                acceptance.main(args)
            self.assertFalse(any(file.exists() for file in extension_files))
            self.assertEqual(smoke.read_text(), 'old evidence')

    def test_extension_pass_keeps_a_failed_smoke_verdict(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'acceptance.json'
            audits = acceptance.AuditedSessions(root/'host', root/'python', root)
            acceptance.record_extension_qualification(
                dict(status='failed', failedAudits=['provider']), output, audits,
                lambda receipt: receipt.write_text('{"status": "passed"}'))
            saved = json.loads(output.read_text())
            self.assertEqual((saved['status'], saved['smokeStatus'], saved['extensionQualification']['status']),
                             ('failed', 'failed', 'passed'))

    def test_running_or_old_passed_receipt_never_survives_a_failure(self):
        for status in ('running','passed'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                output=Path(directory)/'acceptance.json'
                output.write_text(json.dumps({'status':status,'auditedSessions':[{'status':'passed'}]}))
                acceptance.write_failure_receipt(output)
                self.assertEqual(json.loads(output.read_text())['status'],'failed')
                self.assertNotIn('auditedSessions',json.loads(output.read_text()))


class InstallerWaitTests(unittest.TestCase):
    class Process:
        pid = 12345

        def __init__(self, finish=65, code=0):
            self.elapsed = 0
            self.finish = finish
            self.code = code
            self.returncode = None

        def poll(self):
            if self.finish is not None and self.elapsed >= self.finish:
                self.returncode = self.code
            return self.returncode

        def wait(self, timeout):
            self.elapsed += min(timeout, max(0, self.finish - self.elapsed)) if self.finish is not None else timeout
            if self.poll() is None:
                raise subprocess.TimeoutExpired('owned fixture', timeout)
            return self.returncode

        def kill(self):
            self.returncode = -9

    def supervise(self, root, process, check=True, sample_delay=0):
        def sample(*args):
            process.elapsed += min(sample_delay, args[-1])
            return dict(status='collected', files=int(process.elapsed), bytes=int(process.elapsed) * 10)

        def stop(argv, **_kwargs):
            self.assertEqual(argv, ['taskkill', '/PID', '12345', '/T', '/F'])
            process.returncode = -9
            return subprocess.CompletedProcess(argv, 0)

        with patch.object(acceptance.time, 'monotonic', side_effect=lambda: process.elapsed), \
                patch.object(acceptance.subprocess, 'Popen', return_value=process) as launch, \
                patch.object(acceptance, 'installer_progress', side_effect=sample), \
                patch.object(acceptance.subprocess, 'run', side_effect=stop), \
                patch.object(acceptance, 'WINDOWS_INSTALL_TIMEOUT', 60 if process.finish is None else 600):
            result = acceptance.windows_installer(root / 'installer 한글.exe', root / 'Installed App 한글',
                                                 root / 'installer-progress.json', 'fixture', check=check)
        self.assertEqual(launch.call_args.kwargs, {'shell': False})
        self.assertTrue(launch.call_args.args[0].endswith('/D=' + str(root / 'Installed App 한글')))
        return result

    def test_progress_and_elapsed_receipt_survive_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = self.supervise(root, self.Process())
            self.assertEqual([row['files'] for row in result['progress']], [0, 30, 60])
            self.assertEqual((result['status'], result['durationSeconds'], result['timeoutSeconds']), ('passed', 65, 600))
            self.assertEqual(json.loads((root / 'installer-progress.json').read_text())['attempts'], [result])

    def test_nonzero_exit_fails_and_retains_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(subprocess.CalledProcessError):
                self.supervise(root, self.Process(finish=1, code=7))
            result, = json.loads((root / 'installer-progress.json').read_text())['attempts']
            self.assertEqual((result['status'], result['exitCode']), ('failed', 7))

    def test_expected_copy_failure_is_reported_without_becoming_a_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.supervise(Path(temporary), self.Process(finish=1, code=1603), check=False)
            self.assertEqual((result['status'], result['exitCode']), ('failed', 1603))

    def test_continuing_progress_never_extends_deadline_and_only_owned_tree_is_stopped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                self.supervise(root, self.Process(finish=None))
            result, = json.loads((root / 'installer-progress.json').read_text())['attempts']
            self.assertEqual((raised.exception.timeout, result['status'], result['durationSeconds']), (60, 'timed_out', 60))
            self.assertEqual(result['cleanup'], dict(treeStopSucceeded=True, exitCode=-9))
            self.assertEqual([row['files'] for row in result['progress']], [0, 30])

    def test_start_failure_replaces_running_status(self):
        with tempfile.TemporaryDirectory() as temporary:
            receipt = Path(temporary) / 'installer-progress.json'
            with patch.object(acceptance.subprocess, 'Popen', side_effect=OSError('fixture')), self.assertRaises(OSError):
                acceptance.windows_installer(Path('candidate.exe'), Path(temporary), receipt, 'start-failure')
            self.assertEqual(json.loads(receipt.read_text())['attempts'][0]['status'], 'failed')

    def test_probe_time_is_inside_the_fixed_deadline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(subprocess.TimeoutExpired):
                self.supervise(root, self.Process(finish=None), sample_delay=5)
            result, = json.loads((root / 'installer-progress.json').read_text())['attempts']
            self.assertEqual(result['durationSeconds'], 60)
            self.assertEqual([row['elapsedSeconds'] for row in result['progress']], [5, 40])

    def test_receipt_write_failure_still_stops_the_owned_tree_and_preserves_original_error(self):
        process = self.Process(finish=None)
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(acceptance.subprocess, 'Popen', return_value=process), \
                patch.object(acceptance, 'installer_progress', return_value=dict(status='unavailable')), \
                patch.object(acceptance, 'stop_installer', return_value={}) as stop, \
                patch.object(Path, 'write_text', side_effect=[1, OSError('original write failure'), OSError('secondary'), OSError('secondary')]), \
                self.assertRaisesRegex(OSError, 'original write failure'):
            acceptance.windows_installer(Path('candidate.exe'), Path(temporary), Path(temporary) / 'receipt.json', 'disk-full')
        stop.assert_called_once_with(process)

    def test_success_observed_after_a_probe_exhausts_the_deadline_is_not_accepted(self):
        process = self.Process(finish=1)

        def delayed_probe(*_args):
            process.elapsed = 3
            return dict(status='probe_timeout')

        with tempfile.TemporaryDirectory() as temporary:
            receipt = Path(temporary) / 'receipt.json'
            with patch.object(acceptance.subprocess, 'Popen', return_value=process), \
                    patch.object(acceptance.time, 'monotonic', side_effect=lambda: process.elapsed), \
                    patch.object(acceptance, 'WINDOWS_INSTALL_TIMEOUT', 3), \
                    patch.object(acceptance, 'installer_progress', side_effect=delayed_probe), \
                    self.assertRaises(subprocess.TimeoutExpired):
                acceptance.windows_installer(Path('candidate.exe'), Path(temporary), receipt, 'late-exit')
            self.assertEqual(json.loads(receipt.read_text())['attempts'][0]['status'], 'timed_out')

    def test_probe_retains_only_valid_numeric_counters(self):
        values = dict(files=2, bytes=10, cpuSeconds=0.5, readBytes=4, writeBytes=8)
        with patch.object(acceptance.subprocess, 'run', return_value=Mock(stdout=json.dumps(dict(values, secret='private')))):
            self.assertEqual(acceptance.installer_progress(Mock(pid=1), Path('fixture'), 2), dict(values, status='collected'))
        for response in ('[]', '{}', 'not-json', json.dumps(dict(values, files=-1)), json.dumps(dict(values, bytes=float('nan')))):
            with self.subTest(response=response), patch.object(acceptance.subprocess, 'run', return_value=Mock(stdout=response)):
                self.assertEqual(acceptance.installer_progress(Mock(pid=1), Path('fixture'), 2), dict(status='unavailable'))

    def test_diagnostic_timeout_is_recorded_without_changing_the_install_result(self):
        with patch.object(acceptance.subprocess, 'run', side_effect=subprocess.TimeoutExpired('probe', 2)) as run:
            self.assertEqual(acceptance.installer_progress(Mock(pid=1), Path('fixture'), 2), dict(status='probe_timeout'))
        self.assertEqual(run.call_args.kwargs['timeout'], 2)


if __name__ == '__main__':
    unittest.main()
