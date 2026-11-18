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


def invalid_control_fixture(case):
    """Exercise real control validation under an optimized Python interpreter."""
    with tempfile.TemporaryDirectory() as directory:
        root=Path(directory)
        audit=module.AuditedSessions(Path('/owned/host'),Path('/owned/python'),root)
        def run(name,*_args,**_options):
            data={'external':[{'syscall':'connect','pid':20},{'syscall':'sendto','pid':20}],
                  'rootPids':[10],'processes':[{'pid':20,'parentPid':10}]}
            proof={'privateNetworkNamespace':True,'onlyLoopbackInterface':True,'defaultRoutes':0,
                   'hostPid':10,'childPid':20}
            if name==case and case in ('positive-control','child-positive-control'):
                data['external'][1]['syscall']='connect'
            if name=='host-control':
                if case=='namespace':proof['onlyLoopbackInterface']=False
                elif case=='roots':data['rootPids'].append(20)
                elif case=='child':data['external'][0]['pid']=30
                elif case=='syscalls':data['external'][1]['syscall']='connect'
                elif case=='missing-lineage':data['processes']=[]
                elif case=='cycle':data['processes'][0]['parentPid']=20
                (root/'outbound-host-control-fixture.json').write_text(json.dumps(proof))
            (root/('outbound-'+name+'.json')).write_text(json.dumps(data))
            audit.controls.append({'name':name})
        audit.run=run
        with patch.object(module.os,'readlink',return_value='net:[1]'), \
             patch.object(module.tempfile,'TemporaryDirectory',side_effect=RuntimeError('reached_opcode_controls')):
            audit.positive_controls({})


class SessionReceiptTests(unittest.TestCase):
    def run_report(self, root, *, attempts=0, unparsed=0, classification=0, exit_code=0, recaptures=0):
        audit = module.AuditedSessions(Path('/owned/host'), Path('/owned/python'), root)
        audit.enabled = True
        def result(argv, **_options):
            report = Path(argv[argv.index('--report') + 1])
            whole = Path(argv[argv.index('--whole-report') + 1])
            data = dict(scope='selected-process-trees', enforcement='blocking', externalAttempts=attempts,
                        unparsedRecords=unparsed, classificationErrors=classification, processCount=1, rootPids=[1], commandExitCode=0, ioUring=dict(recorded=True,opcodeCounts={},capture=dict(complete=True,drained=True,lostEvents=0)))
            data.update(recaptures=recaptures, captureAttempts=([{'attempt':1,'outcome':'evidence_incomplete'}, {'attempt':2,'outcome':'passed'}] if recaptures else [{'attempt':1,'outcome':'passed'}]))
            report.write_text(json.dumps(data)); whole.write_text(json.dumps(dict(data, scope='all', enforcement='report-only')))
            return subprocess.CompletedProcess(argv, exit_code)
        return audit, result

    def test_recapture_survives_in_ledger_acceptance_summary_and_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            audit,run=self.run_report(root,recaptures=1)
            with patch.object(module,'run_supervised',run), patch('builtins.print') as annotation:
                audit.run('provider',['/owned/command'],env={},timeout=480)
            ledger=json.loads((root/'outbound-sessions.json').read_text())
            self.assertEqual(ledger['auditedSessions'][0]['captureAttempts'][0]['outcome'],'evidence_incomplete')
            self.assertEqual(audit.recapture_summary(),{'outboundRecaptures':1,'recapturedAudits':['provider']})
            self.assertTrue(any('::warning' in str(call) for call in annotation.call_args_list))

    def test_outer_budget_covers_two_captures_without_extending_each_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            audit,run=self.run_report(Path(directory))
            def bounded(command,**options):
                self.assertEqual(command[command.index('--capture-timeout')+1],'480')
                self.assertGreaterEqual(options['timeout'],2*480)
                return run(command,**options)
            with patch.object(module,'run_supervised',bounded):
                audit.run('provider',['/owned/command'],env={},timeout=480)
            self.assertEqual(audit.sessions[0]['captureTimeoutSeconds'],480)

    def test_provider_phases_share_one_budget_even_if_helper_uses_its_full_limit(self):
        import sys
        source=ROOT/'scripts/studio-preview/providerSmoke.py'
        with patch.object(sys,'path',[str(source.parent),*sys.path]):
            spec=importlib.util.spec_from_file_location('provider_phase_budget',source)
            provider=importlib.util.module_from_spec(spec);spec.loader.exec_module(provider)
        with patch.object(provider.time,'monotonic',return_value=300):
            self.assertEqual(provider.phase_timeout(450,240),150)
        with patch.object(provider.time,'monotonic',return_value=451):
            self.assertEqual(provider.phase_timeout(450,240),0)

    def test_provider_attempts_are_rejected_even_if_command_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, run = self.run_report(Path(directory), attempts=1)
            with patch.object(module, 'run_supervised', run), self.assertRaisesRegex(RuntimeError, 'provider'):
                audit.run('provider', ['/owned/provider-smoke'], required=(audit.core,audit.native), env={}, timeout=1)
            ledger = json.loads((Path(directory)/'outbound-sessions.json').read_text())
            self.assertEqual(ledger['auditedSessions'][0]['status'], 'failed')
            self.assertEqual(ledger['auditedSessions'][0]['externalAttempts'], 1)

    def test_unknown_timeout_counts_cannot_defer_failure_even_after_command_success(self):
        with tempfile.TemporaryDirectory() as directory:
            audit,run=self.run_report(Path(directory),attempts=None,unparsed=1,classification=1,exit_code=87)
            with patch.object(module,'run_supervised',run), self.assertRaisesRegex(RuntimeError,'provider'):
                audit.run('provider',['/owned/command'],env={},timeout=480,defer_failure=True)
            self.assertIsNone(audit.sessions[0]['externalAttempts'])
            self.assertEqual(audit.sessions[0]['status'],'failed')

    def test_unparsed_or_classification_failure_is_never_a_zero_receipt(self):
        for fields in [dict(unparsed=1),dict(classification=1),dict(exit_code=87)]:
            with self.subTest(fields=fields), tempfile.TemporaryDirectory() as directory:
                audit, run = self.run_report(Path(directory), **fields)
                with patch.object(module, 'run_supervised', run), self.assertRaises(RuntimeError):
                    audit.run('acp-version', ['/owned/python','--version'],env={},timeout=1)
                self.assertEqual(audit.sessions[0]['status'],'failed')

    def test_each_session_has_separate_reports_and_a_durable_ledger(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, run = self.run_report(Path(directory))
            with patch.object(module, 'run_supervised', run):
                for name in ('acp-version','core-version','provider','permission'):
                    audit.run(name, ['/owned/command'],env={},timeout=1)
            self.assertEqual(len({r['report'] for r in audit.sessions}),4)
            self.assertTrue(all(r['status']=='passed' and r['reportSha256'] for r in audit.sessions))
            self.assertEqual(json.loads((Path(directory)/'outbound-sessions.json').read_text())['auditedSessions'],audit.sessions)

    def test_collecting_remaining_functional_evidence_keeps_failure_in_final_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            audit, run = self.run_report(Path(directory), attempts=1, exit_code=86)
            with patch.object(module,'run_supervised',run):
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

    def test_invalid_positive_controls_still_fail_with_python_optimization(self):
        expected={'positive-control':'Positive control syscall mismatch',
                  'child-positive-control':'Positive control syscall mismatch',
                  'namespace':'Host control network namespace mismatch',
                  'roots':'Host control root mismatch','child':'Host control child mismatch',
                  'syscalls':'Host control syscall mismatch',
                  'missing-lineage':'Missing host-child lineage','cycle':'Missing host-child lineage'}
        code="import runpy,sys;runpy.run_path(sys.argv[1])['invalid_control_fixture'](sys.argv[2])"
        for case,message in expected.items():
            with self.subTest(case=case):
                result=subprocess.run([sys.executable,'-I','-B','-O','-c',code,str(Path(__file__).resolve()),case],
                                      capture_output=True,text=True,timeout=10)
                self.assertNotEqual(result.returncode,0)
                self.assertIn(message,result.stderr)


@unittest.skipUnless(sys.platform=='linux','Linux tracing required')
class RealSessionTests(unittest.TestCase):
    def test_provider_native_attempt_fails_the_real_auditor(self):
        with tempfile.TemporaryDirectory() as directory:
            audit=module.AuditedSessions(Path('/bin/true'),Path(sys.executable),Path(directory))
            with self.assertRaisesRegex(RuntimeError,'provider'):
                audit.run('provider',[sys.executable,'-I','-B',str(audit.auditor),'--positive-control'],
                          required=(audit.native,),env=os.environ,timeout=60)
            self.assertEqual(audit.sessions[0]['auditExitCode'],86)
            self.assertEqual(audit.sessions[0]['externalAttempts'],2)
