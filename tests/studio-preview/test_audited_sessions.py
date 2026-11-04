"""Installer sessions keep Provider/version traffic under the same strict audit."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/studio-preview/packaging/auditedSessions.py'
spec = importlib.util.spec_from_file_location('session_audit', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SessionReceiptTests(unittest.TestCase):
    def run_report(self, root, *, attempts=0, unparsed=0, classification=0, exit_code=0):
        audit = module.AuditedSessions(Path('/owned/host'), Path('/owned/python'), root)
        audit.enabled = True
        def result(argv, **_options):
            report = Path(argv[argv.index('--report') + 1])
            whole = Path(argv[argv.index('--whole-report') + 1])
            data = dict(scope='selected-process-trees', enforcement='blocking', externalAttempts=attempts,
                        unparsedRecords=unparsed, classificationErrors=classification, processCount=1, rootPids=[1], commandExitCode=0, ioUring=dict(recorded=True,opcodeCounts={},capture=dict(complete=True,drained=True,lostEvents=0)))
            report.write_text(json.dumps(data)); whole.write_text(json.dumps(dict(data, scope='all', enforcement='report-only')))
            return subprocess.CompletedProcess(argv, exit_code)
        return audit, result

    def test_provider_attempts_are_rejected_even_if_command_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, run = self.run_report(Path(directory), attempts=1)
            with patch.object(module.subprocess, 'run', run), self.assertRaisesRegex(RuntimeError, 'provider'):
                audit.run('provider', ['/owned/provider-smoke'], required=(audit.core,audit.native), env={}, timeout=1)
            ledger = json.loads((Path(directory)/'outbound-sessions.json').read_text())
            self.assertEqual(ledger['auditedSessions'][0]['status'], 'failed')
            self.assertEqual(ledger['auditedSessions'][0]['externalAttempts'], 1)

    def test_unparsed_or_classification_failure_is_never_a_zero_receipt(self):
        for fields in [dict(unparsed=1),dict(classification=1),dict(exit_code=87)]:
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as directory:
                audit, run = self.run_report(Path(directory), **fields)
                with patch.object(module.subprocess, 'run', run), self.assertRaises(RuntimeError):
                    audit.run('acp-version', ['/owned/python','--version'],env={},timeout=1)
                self.assertEqual(audit.sessions[0]['status'],'failed')

    def test_each_session_has_separate_reports_and_a_durable_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, run = self.run_report(Path(directory))
            with patch.object(module.subprocess, 'run', run):
                for name in ('acp-version','core-version','provider','permission'):
                    audit.run(name, ['/owned/command'],env={},timeout=1)
            self.assertEqual(len({r['report'] for r in audit.sessions}),4)
            self.assertTrue(all(r['status']=='passed' and r['reportSha256'] for r in audit.sessions))
            self.assertEqual(json.loads((Path(directory)/'outbound-sessions.json').read_text())['auditedSessions'],audit.sessions)

    def test_collecting_remaining_functional_evidence_keeps_failure_in_final_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, run = self.run_report(Path(directory), attempts=1, exit_code=86)
            with patch.object(module.subprocess,'run',run):
                audit.run('provider',['/owned/provider-smoke'],env={},timeout=1,defer_failure=True)
            self.assertEqual(audit.failed,['provider'])
            self.assertEqual(audit.sessions[0]['status'],'failed')

    def test_non_linux_runs_functional_check_without_claiming_an_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, _ = self.run_report(Path(directory));audit.enabled=False
            with patch.object(module.subprocess,'run',return_value=subprocess.CompletedProcess([],0)) as run:
                audit.run('provider',['/owned/provider-smoke'],env={},timeout=1)
            self.assertTrue(run.call_args.kwargs['check'])
            self.assertEqual(audit.sessions,[])


@unittest.skipUnless(sys.platform=='linux','Linux tracing required')
class RealSessionTests(unittest.TestCase):
    def test_provider_native_attempt_fails_the_real_auditor(self):
        with tempfile.TemporaryDirectory() as directory:
            audit=module.AuditedSessions(Path('/bin/true'),Path(sys.executable),Path(directory))
            with self.assertRaisesRegex(RuntimeError,'provider'):
                audit.run('provider',[sys.executable,'-I','-B',str(audit.auditor),'--positive-control'],
                          required=(audit.native,),env=os.environ,timeout=30)
            self.assertEqual(audit.sessions[0]['auditExitCode'],86)
            self.assertEqual(audit.sessions[0]['externalAttempts'],2)
