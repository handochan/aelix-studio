"""Monaco keeps build helpers, their last sends and all failures inside the audit."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager, redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / 'tests/outbound-audit/monacoBuildFixture.mjs'
SCRIPT = ROOT / 'scripts/studio-preview/fixtures/outboundAudit.py'
spec = importlib.util.spec_from_file_location('monaco_audit', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


@unittest.skipUnless(shutil.which('node') and (ROOT / 'node_modules/esbuild').exists(), 'Installed Node build tools required')
class BuildComparisonTests(unittest.TestCase):
    def test_original_sync_async_only_and_managed_builds_have_identical_outputs(self):
        (ROOT / '.local').mkdir(exist_ok=True)
        measurements = {}
        receipts = {}
        for mode in ('baseline', 'async-only', 'managed'):
            with tempfile.TemporaryDirectory(prefix='monaco-build-', dir=ROOT / '.local') as directory:
                result = subprocess.run(['node', str(FIXTURE), mode, directory], cwd=ROOT,
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                receipts[mode] = json.loads(result.stdout.strip().splitlines()[-1])
                root = Path(directory)
                measurements[mode] = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                                      for p in [*sorted((root / 'dist').rglob('*')), root / 'dictionaryServer.cjs'] if p.is_file()}
                if mode == 'managed':
                    lifecycle = receipts[mode]
                    self.assertEqual(lifecycle['status'], 'passed')
                    self.assertGreater(len(lifecycle['helpers']), 0)
                    self.assertTrue(all(h['exited'] and h['closed'] for h in lifecycle['helpers']))
        self.assertEqual(measurements['baseline'], measurements['async-only'])
        self.assertEqual(measurements['baseline'], measurements['managed'])
        output = ROOT / '.local/outbound/monaco-controls'
        output.mkdir(parents=True, exist_ok=True)
        (output / 'build-comparison.json').write_text(json.dumps({'outputs': measurements, 'receipts': receipts}, indent=2) + '\n')
        if sys.platform == 'linux':
            self.assertEqual(len(receipts['baseline']['buildHelperPids']), 2)
            self.assertEqual(len(receipts['async-only']['buildHelperPids']), 1)


class CaptureFailureTests(unittest.TestCase):
    def test_terminal_and_child_holes_are_not_discharged_by_build_success(self):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'trace'
            trace.write_text('1<node> execve("/owned/node", [...], 0x1) = 0\n'
                             '1<node> clone(child_stack=NULL, flags=SIGCHLD) = 2\n')
            report = audit.analyze_processes([trace], require_lifecycle=True)[0]
        reasons = {item['reason'] for item in report['classificationIssues']}
        self.assertIn('missing_terminal_record', reasons)
        self.assertIn('missing_child_records', reasons)
        self.assertGreater(report['unparsedRecords'], 0)

    def test_forced_tracer_EIO_is_a_failure_without_replay_even_if_fixture_passed(self):
        measurement = dict(status='failed', outcome='evidence_incomplete', commandStarted=True, commandExitCode=1,
                           externalAttempts=0, unparsedRecords=1, classificationIssues=[{'reason':'unknown_record'}],
                           processes=[], externalOperationDiagnostics=[])
        @contextmanager
        def fail(_command, path, *, allow_recapture, **_options):
            path.write_text(json.dumps(measurement))
            yield 87, None, allow_recapture and audit.should_recapture(measurement)
        with tempfile.TemporaryDirectory() as directory, patch.object(audit, 'capture_once', side_effect=fail) as run, redirect_stdout(io.StringIO()):
            report = Path(directory) / 'audit.json'
            code = audit.audit(['node', str(FIXTURE), 'managed'], report)
            self.assertEqual((code, run.call_count, json.loads(report.read_text())['recaptures']), (87, 1, 0))


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('node'), 'Linux kernel/strace capture required')
class AuditedBuildTests(unittest.TestCase):
    def run_audit(self, command, name):
        output = ROOT / '.local/outbound/monaco-controls'
        output.mkdir(parents=True, exist_ok=True)
        report = output / (name + '.json')
        with redirect_stdout(io.StringIO()):
            code = audit.audit(command, report)
        return code, json.loads(report.read_text())

    def test_managed_Vite_dictionary_and_worker_build_remain_inside_complete_capture(self):
        (ROOT / '.local').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='monaco-audited-build-', dir=ROOT / '.local') as directory:
            code, report = self.run_audit(['node', str(FIXTURE), 'managed', directory], 'managed-build')
        self.assertEqual((code, report['externalAttempts'], report['unparsedRecords']), (0, 0, 0))
        self.assertTrue(report['ioUring']['capture']['complete'])

    def test_helper_last_TCP_and_UDP_attempts_are_still_denied(self):
        code, report = self.run_audit(['node', str(FIXTURE), 'tail-send'], 'tail-send')
        self.assertEqual((code, report['externalAttempts'], report['unparsedRecords']), (86, 2, 0))
        self.assertEqual(report['recaptures'], 0)

    def test_functional_assertion_still_fails_after_successful_build_shutdown(self):
        (ROOT / '.local').mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='monaco-assertion-', dir=ROOT / '.local') as directory:
            code, report = self.run_audit(['node', str(FIXTURE), 'assertion-failure', directory], 'assertion-failure')
        self.assertEqual((code, report['commandExitCode'], report['unparsedRecords'], report['recaptures']), (1, 1, 0, 0))
        self.assertEqual(report['outcome'], 'command_failed')

    def test_real_capture_with_injected_tracer_EIO_and_missing_records_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            tracer = Path(directory) / 'strace'
            tracer.write_text('#!' + sys.executable + '\nimport os,sys\n'
                              'if "--version" in sys.argv: print("strace EIO fixture"); raise SystemExit(0)\n'
                              'path=sys.argv[sys.argv.index("-o")+1]\n'
                              'open(path,"w").write(f"{os.getpid()}<node> clone(child_stack=NULL, flags=SIGCHLD) = 999999\\n")\n'
                              'print("ptrace(PTRACE_LISTEN): Input/output error",file=sys.stderr)\n'
                              'raise SystemExit(1)\n')
            tracer.chmod(0o755)
            with patch.object(audit, 'resolve_strace', return_value=str(tracer)):
                code, report = self.run_audit(['/bin/true'], 'tracer-eio')
        self.assertEqual((code, report['commandExitCode'], report['recaptures']), (87, 1, 0))
        self.assertGreater(report['unparsedRecords'], 0)
