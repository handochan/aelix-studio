"""Scoped syscall audit: lineage, attribution, fail-closed parsing and real children."""
import importlib.util
import copy
import io
from contextlib import contextmanager, nullcontext, redirect_stderr, redirect_stdout
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/studio-preview/fixtures/outboundAudit.py'
spec = importlib.util.spec_from_file_location('scoped_outbound_audit', SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

HOST = '/owned/aelix-studio-host'
PYTHON = '/owned/native/python3'
CONNECT = 'connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, 16) = -1 ENETUNREACH (Network unreachable)'
LOCAL = CONNECT.replace('203.0.113.1', '127.0.0.1')


def task_capture_fixture():
    return dict(status='captured',complete=True,drained=True,lostEvents=0,pidNamespaceVerified=True,
        namespaceInode=7,eventCount=0,events=[],recordErrors=[],root={'kernelPid':100},
        network={'complete':True,'eventCount':0,'events':[],'workers':[],
            'tasks':[dict(pid=p,tgid=p,kernelPid=k,kernelTgid=k,parentKernelPid=parent,
                          start=1,end=100,lastOrdinal=10,kernelThread=False,ioWorker=False)
                     for p,k,parent in [(100,100,0),(1,101,100)]]})


class CaptureStartupFailureTests(unittest.TestCase):
    def test_failed_start_retains_partial_tasks_without_upgrading_namespace_or_capture(self):
        def factory(directory):
            (directory/'events.raw').write_text('READY\nROOT|1|100|100|123|1\n'
                'P|2|101|101|124|124|1|1|3|0\n'
                'T|5|101|101|124|124|1|100|0|1\nLost 7 events\nUNKNOWN PRIVATE_RECORD\n')
            capture=Mock(namespace=7);capture.start.side_effect=RuntimeError('kernel_tracepoint_unavailable')
            capture.stop.return_value=dict(status='failed',complete=False,pidNamespaceVerified=False,
                lostEvents=0,events=[],eventCount=0)
            return capture
        with tempfile.TemporaryDirectory() as directory:
            report=Path(directory)/'report.json';process=Mock(pid=123,returncode=0);process.poll.return_value=0
            with patch.dict(os.environ,{},clear=True),patch.object(audit.sys,'platform','linux'), \
                 patch.object(audit,'resolve_strace',return_value='/usr/bin/strace'), \
                 patch.object(audit,'npm_config_paths',return_value=[]), \
                 patch.object(audit,'npm_proxy_configured',return_value=False), \
                 patch.object(audit,'Capture',side_effect=factory), \
                 patch.object(audit,'capture_deadline',return_value=nullcontext()), \
                 patch.object(audit.signal,'setitimer',create=True),patch.object(audit.signal,'ITIMER_REAL',0,create=True), \
                 patch.object(audit.subprocess,'Popen',return_value=process):
                code=audit.audit(['/owned/command'],report)
            result=json.loads(report.read_text())
        self.assertEqual(code,87)
        self.assertFalse(result['ioUring']['capture']['complete'])
        self.assertFalse(result['ioUring']['capture']['pidNamespaceVerified'])
        self.assertTrue(result['taskEvidence']['source']['diagnosticSnapshotUsed'])
        self.assertEqual(result['taskEvidence']['source']['lostEvents'],7)
        self.assertEqual(result['taskEvidence']['source']['recordErrorCount'],1)
        self.assertEqual(result['taskEvidence']['tasks'][0]['namespaceTid'],124)
        self.assertEqual(result['taskEvidence']['networkRecordCounts']['P'],1)
        self.assertNotIn('PRIVATE_RECORD',json.dumps(result))
        self.assertNotIn('taskRecordingSnapshot',result['ioUring']['capture'])

    def test_start_failure_is_preserved_even_when_broker_evidence_is_unavailable(self):
        for broker_error in (False,True):
            with self.subTest(broker_error=broker_error), tempfile.TemporaryDirectory() as directory:
                capture=Mock()
                capture.start.side_effect=RuntimeError('kernel_tracepoint_unavailable')
                if broker_error:capture.stop.side_effect=OSError('missing broker result')
                else:capture.stop.return_value={'status':'failed','complete':False,'lostEvents':0,
                    'pidNamespaceVerified':False,'events':[],'eventCount':0,'reason':'kernel_recorder_sudo_required'}
                process=Mock(pid=123,returncode=0);process.poll.return_value=0
                report=Path(directory)/'report.json'
                with patch.dict(os.environ,{},clear=True), patch.object(audit.sys,'platform','linux'), \
                     patch.object(audit.shutil,'which',return_value='/usr/bin/strace'), \
                     patch.object(audit,'npm_config_paths',return_value=[]), \
                     patch.object(audit,'npm_proxy_configured',return_value=False), \
                     patch.object(audit,'Capture',return_value=capture), \
                     patch.object(audit,'capture_deadline',return_value=nullcontext()), \
                     patch.object(audit.signal,'setitimer',create=True), \
                     patch.object(audit.signal,'ITIMER_REAL',0,create=True), \
                     patch.object(audit.subprocess,'Popen',return_value=process):
                    code=audit.audit(['/owned/command'],report)
                evidence=json.loads(report.read_text())['ioUring']['capture']
                self.assertEqual(code,87)
                self.assertEqual(evidence['reason'],'kernel_tracepoint_unavailable')
                self.assertIn({'reason':'kernel_tracepoint_unavailable'},evidence['recordErrors'])


class RecaptureTests(unittest.TestCase):
    def run_attempts(self, root, measurements, **options):
        @contextmanager
        def capture(_command, path, **_options):
            code, report = measurements.pop(0)
            path.write_text(json.dumps(report))
            yield code, None
        path = root/'audit.json'
        with patch.object(audit, 'capture_once', side_effect=capture) as run, redirect_stdout(io.StringIO()) as output:
            code = audit.audit(['/owned/isolated-fixture'], path, **options)
        self.audit_stdout = output.getvalue()
        return code, json.loads(path.read_text()), run.call_count

    def incomplete(self, **fields):
        return dict(outcome='evidence_incomplete', externalAttempts=29, unparsedRecords=2,
                    classificationIssues=[{'reason':'unknown_record'}, {'reason':'kernel_network_strace_entry_missing'}],
                    externalOperationDiagnostics=[dict(syscall='connect',straceSocketKind='udp',
                        udpWriteAssociations=[]) for _ in range(29)],
                    commandStarted=True, commandExitCode=0, **fields)

    KERNEL_RAW = ('READY\nROOT|1|100|100|10|1\nSTATE|5|1|1|0|0\n'
                  'T|5|100|100|10|10|1|0|0|0\nOBJECTS|1\nDONE\n'
                  '@root_count: 1\n@state_count: 1\n@born_count: 1\n@dead_count: 1\n'
                  '@task_count: 1\n@udp_task_exit_enter: 1\n@udp_task_exit_return: 1\n')

    def kernel_loss(self):
        from uring.capture import parse
        capture = parse(self.KERNEL_RAW, '', 0, 1)
        self.assertTrue(capture['complete'])
        # The real ip_local_out failure occurred after a complete, drained parse.
        capture.update(complete=False, status='failed', reason='kernel_bpf_program_recursion_lost',
            programLoss={'stage':'after-detach','programs':[{'prog_type':26,'programName':'ip_local_out','recursion_misses':1}]})
        report = self.incomplete()
        report.update(externalAttempts=0, externalOperationDiagnostics=[], unparsedRecords=3,
            classificationIssues=[{'reason':reason} for reason in ('io_uring_kernel_capture_incomplete',
                'udp_socket_capture_incomplete','kernel_network_capture_incomplete')],
            processes=[{'pid':10,'unparsedRecords':0,'unparsedRecordKinds':{}}],
            ioUring={'capture':capture}, observedRejectedOpcodes=[])
        return report

    def assert_no_recapture(self, report):
        with tempfile.TemporaryDirectory() as directory:
            code,_,count = self.run_attempts(Path(directory), [(87,report),
                (0,dict(outcome='passed',externalAttempts=0,unparsedRecords=0))])
        self.assertEqual((code,count),(87,1))

    def test_real_bpf_loss_without_record_holes_can_recapture_and_keeps_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            code,report,count = self.run_attempts(Path(directory), [(87,self.kernel_loss()),
                (0,dict(outcome='passed',externalAttempts=0,unparsedRecords=0))])
        self.assertEqual((code,count,report['recaptures']),(0,2,1))
        # The producer still emits the real annotation; this test captures it.
        self.assertIn('::warning title=Outbound audit recapture::', self.audit_stdout)

    def test_observed_forbidden_opcode_blocks_kernel_loss_recapture(self):
        report=self.kernel_loss();report['observedRejectedOpcodes']=[16]
        self.assert_no_recapture(report)

    def test_unparsed_accounting_must_match_process_and_report_totals(self):
        for mismatch in ('process','report'):
            with self.subTest(mismatch=mismatch):
                report=self.incomplete()
                report['ioUring']={'capture':{'complete':True,'recordErrors':[]}}
                if mismatch=='process':
                    report['processes']=[{'unparsedRecords':1,'unparsedRecordKinds':{'register_stub':2}}]
                    report['unparsedRecords']=4
                else:report['unparsedRecords']=3
                self.assert_no_recapture(report)

    def test_kernel_reason_namespace_and_diagnostics_must_allow_recapture(self):
        for field,value in [('reason','unsupported_kernel_capture'),('pidNamespaceVerified',False),
                            ('diagnostics',['unexpected recorder diagnostic'])]:
            with self.subTest(field=field):
                report=self.kernel_loss();report['ioUring']['capture'][field]=value
                self.assert_no_recapture(report)

    def test_any_kernel_error_counter_blocks_recapture(self):
        for counter in ('namespace_error','unsupported_abi','pre_mismatch','network_return_id_error',
                        'raw_state_overlap','pre_layout_error','socket_layout_error','worker_error',
                        'udp_object_error','untracked_sqpoll','unmatched_completion'):
            with self.subTest(counter=counter):
                report=self.kernel_loss();report['ioUring']['capture']['kernelCounts'][counter]=1
                self.assert_no_recapture(report)

    def test_unlisted_or_malformed_kernel_record_errors_block_recapture(self):
        for errors in ([{'reason':'unknown_record'}], ['invalid_record']):
            with self.subTest(errors=errors):
                report=self.kernel_loss();report['ioUring']['capture']['recordErrors']=errors
                self.assert_no_recapture(report)

    def test_incomplete_report_without_any_reason_is_not_recaptured(self):
        report=self.incomplete()
        report.update(externalAttempts=0,externalOperationDiagnostics=[],unparsedRecords=0,
            classificationIssues=[],processes=[],ioUring={'capture':{'complete':True,'recordErrors':[]}})
        self.assert_no_recapture(report)

    def test_actual_perf_loss_parser_shape_is_not_recaptured(self):
        from uring.capture import parse
        report=self.kernel_loss()
        report['ioUring']['capture']=parse(self.KERNEL_RAW,'Lost 1 events',0,1)
        capture=report['ioUring']['capture']
        self.assertEqual((capture['complete'],capture['lostEvents'],capture['pidNamespaceVerified']),
                         (False,1,False))
        self.assertEqual(capture['reason'],'io_uring_kernel_events_lost')
        self.assert_no_recapture(report)

    def test_incomplete_kernel_with_any_record_hole_fails_first_capture(self):
        for hole in ('register_stub','unknown_record','kernel_network_strace_entry_missing'):
            with self.subTest(hole=hole):
                report=self.kernel_loss()
                report['unparsedRecords']+=1
                if hole=='register_stub':
                    report['processes'][0].update(unparsedRecords=1,unparsedRecordKinds={'register_stub':1})
                else:report['classificationIssues'].append({'reason':hole})
                self.assert_no_recapture(report)

    def test_complete_kernel_keeps_record_hole_recapture(self):
        from uring.capture import parse
        for hole in ('register_stub','unknown_record','kernel_network_strace_entry_missing'):
            with self.subTest(hole=hole), tempfile.TemporaryDirectory() as directory:
                report=self.kernel_loss();report['ioUring']['capture']=parse(self.KERNEL_RAW,'',0,1)
                report.update(unparsedRecords=1,classificationIssues=[])
                if hole=='register_stub':
                    report['processes'][0].update(unparsedRecords=1,unparsedRecordKinds={'register_stub':1})
                else:report['classificationIssues']=[{'reason':hole}]
                code,_,count=self.run_attempts(Path(directory),[(87,report),
                    (0,dict(outcome='passed',externalAttempts=0,unparsedRecords=0))])
                self.assertEqual((code,count),(0,2))

    def test_observed_or_undecodable_network_operations_never_replay(self):
        cases = [
            'accept4(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.1")}, [16], 0) = 4',
            'sendto(3, "", 0, 0, 0x1234, 16) = -1 EFAULT (Bad address)',
            'connect(3, {sa_family=AF_XDP}, 16) = -1 EAFNOSUPPORT (Address family not supported)',
            'write(3<socket:[1234]>, "", 0) = 0',
            'sendto(3<TCP:[127.0.0.1:1234->broken]>, "", 0, 0, NULL, 0) = 0',
        ]
        for call in cases:
            with self.subTest(call=call), tempfile.TemporaryDirectory() as directory:
                root=Path(directory); trace=root/'trace'
                trace.write_text('1<app> '+call+'\n1<app> +++ exited with 0 +++\n')
                measured=audit.analyze_processes([trace],require_lifecycle=True)[0]
                self.assertGreater(measured['unparsedRecords'],0)
                measured.update(outcome='evidence_incomplete',commandStarted=True,commandExitCode=0)
                code,_,count=self.run_attempts(root,[(87,measured)])
                self.assertEqual((code,count),(87,1))

    def test_mixed_allowed_gap_and_unlisted_issue_cannot_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            measured=self.incomplete()
            measured['classificationIssues'].append({'reason':'unsupported_external_accept'})
            measured['unparsedRecords']+=1
            code,_,count=self.run_attempts(Path(directory),[(87,measured)])
            self.assertEqual((code,count),(87,1))

    def test_two_incomplete_measurements_fail_after_exactly_one_recapture(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            code, report, calls=self.run_attempts(root, [(87,self.incomplete()), (87,self.incomplete())])
            self.assertEqual((code,calls,report['recaptures']), (87,2,1))
            self.assertEqual(report['externalAttempts'],29)
            self.assertEqual(len(list(root.glob('audit.capture-*.json'))),2)

    def test_complete_recapture_retains_first_incomplete_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            code, report, calls=self.run_attempts(root, [(87,self.incomplete()),
                (0,dict(outcome='passed',externalAttempts=0,unparsedRecords=0))])
            self.assertEqual((code,calls), (0,2))
            self.assertEqual(report['captureAttempts'][0]['externalAttempts'],29)
            self.assertEqual(json.loads((root/'audit.capture-1.json').read_text())['unparsedRecords'],2)

    def test_complete_external_attempt_is_not_retried_or_erased(self):
        with tempfile.TemporaryDirectory() as directory:
            code, report, calls=self.run_attempts(Path(directory), [(86,
                dict(outcome='external_attempts',externalAttempts=2,unparsedRecords=0))])
            self.assertEqual((code,calls,report['externalAttempts']), (86,1,2))

    def test_external_attempt_in_second_capture_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            code, report, calls=self.run_attempts(Path(directory), [(87,self.incomplete()),
                (86,dict(outcome='external_attempts',externalAttempts=2,unparsedRecords=0))])
            self.assertEqual((code,calls,report['recaptures']), (86,2,1))

    def test_functional_failure_and_known_forbidden_operation_cannot_be_hidden(self):
        for change in (dict(commandExitCode=1), dict(classificationIssues=[{'reason':'io_uring_opcode_not_allowed'}])):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                measurement=self.incomplete();measurement.update(change)
                code, _, calls=self.run_attempts(Path(directory), [(87,measurement)])
                self.assertEqual((code,calls), (87,1))

    def test_configuration_refusal_is_not_recaptured(self):
        with tempfile.TemporaryDirectory() as directory:
            code, _, calls=self.run_attempts(Path(directory), [(87,dict(reason='proxy_environment'))])
            self.assertEqual((code,calls), (87,1))

    def test_one_shot_negative_control_still_fails_on_first_incomplete_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            code, report, calls=self.run_attempts(Path(directory), [(87,self.incomplete())],recapture=False)
            self.assertEqual((code,calls,report['recaptures']), (87,1,0))

    def test_incomplete_capture_cannot_erase_known_tcp_or_udp_writes(self):
        for change in (dict(syscall='sendto'), dict(straceSocketKind='tcp'),
                       dict(udpWriteAssociations=[{'syscall':'write'}]),
                       dict(kernel={'socketHooks':['tcp_v6_connect']})):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                measurement=self.incomplete()
                measurement['externalOperationDiagnostics'][0].update(change)
                code, _, calls=self.run_attempts(Path(directory), [(87,measurement)])
                self.assertEqual((code,calls), (87,1))

    def test_incomplete_capture_without_destination_diagnostics_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            measurement=self.incomplete();measurement['externalOperationDiagnostics']=[]
            code, _, calls=self.run_attempts(Path(directory), [(87,measurement)])
            self.assertEqual((code,calls), (87,1))


@unittest.skipUnless(hasattr(audit.signal,'setitimer'),'POSIX capture deadline required')
class CaptureDeadlineTests(unittest.TestCase):
    def test_capture_bound_includes_report_processing_not_only_collection(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(audit,'_capture_once',side_effect=lambda *a,**k: time.sleep(1)):
            path=Path(directory)/'report.json'
            with audit.capture_once(['/owned/command'],path,capture_timeout=0.02) as (code, collect):
                self.assertEqual((code, collect), (87, None))
            self.assertEqual(json.loads(path.read_text())['outcome'],'capture_timeout')

    def test_failed_collection_analysis_keeps_its_remaining_budget(self):
        capture=Mock();capture.start.side_effect=RuntimeError('kernel_tracepoint_unavailable')
        capture.stop.return_value={'status':'failed','complete':False,'reason':'kernel_tracepoint_unavailable'}
        process=Mock(pid=123,returncode=0);process.poll.return_value=0
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True), \
             patch.object(audit.sys,'platform','linux'), patch.object(audit,'resolve_strace',return_value='/bin/true'), \
             patch.object(audit,'npm_config_paths',return_value=[]), patch.object(audit,'npm_proxy_configured',return_value=False), \
             patch.object(audit,'Capture',return_value=capture), patch.object(audit.subprocess,'Popen',return_value=process), \
             patch.object(audit,'measure_processes',side_effect=lambda *a,**k: time.sleep(1)):
            path=Path(directory)/'timeout.json'
            with audit.capture_once(['/owned/command'],path,capture_timeout=0.03) as (code, collect):
                self.assertEqual((code, collect), (87, None))
            self.assertIsNone(json.loads(path.read_text())['externalAttempts'])
            self.assertEqual(json.loads(path.read_text())['outcome'],'capture_timeout')

    def test_capture_deadline_fails_without_extending_the_bound_for_replay(self):
        with self.assertRaisesRegex(RuntimeError,'capture_timeout'):
            with audit.capture_deadline(0.02): time.sleep(1)


@unittest.skipUnless(hasattr(audit.signal,'setitimer'),'POSIX capture deadline required')
class TaskEvidenceIsolationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.report = self.root / 'audit.json'
        self.whole = self.root / 'whole.json'

    def audit_traces(self, traces, *, capture=None, stderr=b'', scoped=False):
        tracer = self.root / 'strace'
        tracer.touch()
        process = Mock(pid=123, returncode=0)
        process.poll.return_value = 0
        inputs = iter(traces)
        raw_directories = []

        def factory(directory):
            raw_directories.append(directory)
            records = next(inputs)

            def start(_pid):
                (directory / 'stopped.json').touch()
                (directory / 'network.trace').write_text('\n'.join([
                    '1<app> execve("/owned/app", [...], 0x1) = 0',
                    *(f'1<app> {record}' for record in records),
                    '1<app> +++ exited with 0 +++',
                ]) + '\n')
                (directory / 'command.stderr').write_bytes(stderr)

            return Mock(namespace=7, start=start, stop=Mock(return_value=copy.deepcopy(capture or task_capture_fixture())))

        with patch.dict(os.environ, {}, clear=True), patch.object(audit.sys, 'platform', 'linux'), \
             patch.object(audit, 'resolve_strace', return_value=str(tracer)), \
             patch.object(audit, 'npm_config_paths', return_value=[]), \
             patch.object(audit, 'npm_proxy_configured', return_value=False), \
             patch.object(audit, 'Capture', side_effect=factory), patch.object(audit.os, 'kill'), \
             patch.object(audit, 'process_table', return_value={}), \
             patch.object(audit.subprocess, 'Popen', return_value=process), \
             patch.object(audit.subprocess, 'check_output', return_value='strace test\n'), \
             redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = audit.audit(['/owned/app'], self.report, capture_timeout=1,
                               scope_executables=('/owned/app',) if scoped else (),
                               whole_report_path=self.whole if scoped else None)
        self.assertFalse(any(directory.exists() for directory in raw_directories))
        return code, len(raw_directories)

    def read(self, path=None):
        return json.loads((path or self.report).read_text())

    def assert_unavailable(self, report):
        self.assertEqual(report['taskEvidenceStatus'], 'unavailable')
        self.assertNotIn('taskEvidence', report)

    def test_slow_diagnostic_collection_preserves_a_passing_capture(self):
        from uring import network
        completed = []

        def delayed(*args, **kwargs):
            time.sleep(1.3)
            completed.append(True)

        with patch.object(network, 'summarize_tasks', side_effect=delayed) as summarize, \
             patch.object(audit, 'TASK_EVIDENCE_COLLECTION_TIMEOUT', 0.15):
            self.assertEqual(self.audit_traces([[]]), (0, 1))
        self.assertEqual((summarize.call_count, completed), (1, []))
        report = self.read()
        self.assertEqual((report['outcome'], report['recaptures']), ('passed', 0))
        self.assert_unavailable(report)

    def test_first_capture_can_replay_when_its_diagnostic_collection_times_out(self):
        from uring import network
        summarize = network.summarize_tasks
        calls = []

        def delay_first(*args, **kwargs):
            calls.append(True)
            if len(calls) == 1:
                time.sleep(1.3)
            return summarize(*args, **kwargs)

        with patch.object(network, 'summarize_tasks', side_effect=delay_first), \
             patch.object(audit, 'TASK_EVIDENCE_COLLECTION_TIMEOUT', 0.15):
            self.assertEqual(self.audit_traces([['??? PORTABLE_UNKNOWN'], []]), (0, 2))
        report = self.read()
        self.assertEqual([entry['exitCode'] for entry in report['captureAttempts']], [87, 0])
        self.assertEqual((report['recaptures'], report['taskEvidenceStatus']), (1, 'available'))
        first = self.read(self.root / 'audit.capture-1.json')
        self.assertEqual(first['outcome'], 'evidence_incomplete')
        self.assert_unavailable(first)

    def test_summary_exception_preserves_pass_denial_and_second_incomplete_capture(self):
        from uring import network
        capture = task_capture_fixture()
        capture['network']['events'] = [dict(kind=kind,time=stamp,pid=1,tgid=1,kernelPid=101,kernelTgid=101,
            call=1,ordinal=1,value=3,result=-101 if kind=='X' else 0) for stamp,kind in enumerate('PNX',2)]
        capture['network']['eventCount'] = 3
        cases = [([[]], None, [0], 'passed'),
                 ([[CONNECT]], capture, [86], 'external_attempts'),
                 ([['??? PORTABLE_UNKNOWN']]*2, None, [87, 87], 'evidence_incomplete')]
        for traces, evidence, codes, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(network, 'summarize_tasks', side_effect=ValueError('PRIVATE_ERROR')):
                self.assertEqual(self.audit_traces(traces, capture=evidence), (codes[-1], len(codes)))
                report = self.read()
                self.assertEqual(([row['exitCode'] for row in report['captureAttempts']], report['outcome']), (codes, outcome))
                self.assert_unavailable(report)

    def test_partial_diagnostic_write_leaves_scoped_and_whole_verdicts_readable(self):
        write_text = Path.write_text
        failures = []

        def fail_with_evidence(path, text, *args, **kwargs):
            if '"taskEvidence"' in text:
                failures.append(path)
                write_text(path, '{')
                raise OSError(28, 'simulated diagnostic storage failure')
            return write_text(path, text, *args, **kwargs)

        with patch.object(Path, 'write_text', fail_with_evidence):
            self.assertEqual(self.audit_traces([[]], scoped=True), (0, 1))
        self.assertTrue(failures)
        self.assertEqual(self.read()['outcome'], 'passed')
        self.assertEqual(self.read(self.whole)['enforcement'], 'report-only')
        for path in (self.report, self.whole, self.root / 'audit.capture-1.json', self.root / 'whole.capture-1.json'):
            self.assert_unavailable(self.read(path))
        self.assertEqual(list(self.root.glob('.task-evidence-*')), [])

    def test_diagnostic_write_timeout_keeps_the_first_incomplete_capture_and_replays(self):
        write_text = Path.write_text
        writes = []

        def delay_first_write(path, text, *args, **kwargs):
            if '"taskEvidence"' in text and not writes:
                writes.append(path)
                write_text(path, '{')
                time.sleep(1.3)
            return write_text(path, text, *args, **kwargs)

        with patch.object(Path, 'write_text', delay_first_write), \
             patch.object(audit, 'TASK_EVIDENCE_WRITE_TIMEOUT', 0.15):
            self.assertEqual(self.audit_traces([['??? PORTABLE_UNKNOWN'], []]), (0, 2))
        self.assertEqual(len(writes), 1)
        first = self.read(self.root / 'audit.capture-1.json')
        self.assertEqual(first['outcome'], 'evidence_incomplete')
        self.assert_unavailable(first)
        self.assertEqual(self.read()['taskEvidenceStatus'], 'available')

    def test_late_unsupported_personality_is_indexed_in_both_reports(self):
        stderr = b'Proper structure decoding for this personality is not supported\n'
        self.assertEqual(self.audit_traces([[]], stderr=stderr, scoped=True), (87, 1))
        for path in (self.report, self.whole):
            report = self.read(path)
            indices = report['taskEvidence']['globalClassificationIssueIndices']
            self.assertIn({'reason':'unsupported_strace_personality'}, [report['classificationIssues'][i] for i in indices])


class CleanupIdentityTests(unittest.TestCase):
    def setUp(self):
        # The algorithm uses mocked /proc and kill; retain that coverage on Windows.
        signals=patch.object(audit.signal,'SIGKILL',9,create=True)
        signals.start();self.addCleanup(signals.stop)

    def test_privileged_signal_tolerates_a_process_exiting_before_revalidation(self):
        with patch.object(sys,'argv',['signal','123','old','9']), patch.object(audit.Path,'read_text',side_effect=FileNotFoundError), patch.object(audit.os,'kill') as kill:
            exec(audit.OWNED_SIGNAL,{})
        kill.assert_not_called()

    def test_privileged_signal_rejects_a_reused_pid(self):
        raw='123 (owned) '+' '.join(['S','1']+['0']*17+['new'])
        with patch.object(sys,'argv',['signal','123','old','9']), patch.object(audit.Path,'read_text',return_value=raw), patch.object(audit.os,'kill') as kill:
            exec(audit.OWNED_SIGNAL,{})
        kill.assert_not_called()

    def test_reused_root_is_not_owned(self):
        table={100:(1,'new','S'),201:(100,'child','S')}
        with patch.object(audit,'process_table',return_value=table), patch.object(audit.os,'kill') as kill:
            audit.stop_owned_tree(100,include_root=True,root_birth='old',grace=0)
        kill.assert_not_called()

    def test_outer_fallback_keeps_subreaper_until_adopted_children_are_gone(self):
        table={100:(1,'root','S'),200:(100,'old','S')}
        signalled=[]
        def kill(pid,_signal):
            signalled.append(pid)
            table.pop(pid)
            if pid==200:table[201]=(100,'adopted','S')
        with patch.object(audit,'process_table',side_effect=lambda:dict(table)), patch.object(audit.os,'kill',side_effect=kill):
            audit.stop_owned_tree(100,include_root=True,root_birth='root',grace=0)
        self.assertEqual(signalled,[200,201,100])

    def test_force_cleanup_rescans_newly_adopted_children(self):
        table={100:(1,'root','S'),200:(100,'old','S')}
        signalled=[]
        def kill(pid,_signal):
            signalled.append(pid)
            table.pop(pid)
            if pid==200:table[201]=(100,'adopted','S')
        with patch.object(audit,'process_table',side_effect=lambda:dict(table)), patch.object(audit.os,'kill',side_effect=kill):
            audit.stop_owned_tree(100,root_birth='root',grace=0)
        self.assertEqual(signalled,[200,201])


@unittest.skipUnless(sys.platform=='linux','Linux subreaper required')
class SupervisionTests(unittest.TestCase):
    def test_timeout_stops_a_detached_descendant_before_returning(self):
        import time
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pidfile=root/'pid.json'
            child=root/'child.py'
            child.write_text('import os,signal,time,json,sys\n'
                'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                'open(sys.argv[1],"w").write(json.dumps({"pid":os.getpid()}))\n'
                'while True:time.sleep(1)\n')
            parent=root/'parent.py'
            parent.write_text('import subprocess,sys,time\n'
                'subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2]],start_new_session=True)\n'
                'while True:time.sleep(1)\n')
            code=('import runpy,sys; m=runpy.run_path(sys.argv[1]); g=m["supervise"].__globals__;'
                  'g["SUPERVISOR_CLEANUP"]=0.1;g["CAPTURE_CLEANUP"]=0.1;'
                  'raise SystemExit(m["supervise"](sys.argv[2:],0.5))')
            result=subprocess.run([sys.executable,'-I','-B','-c',code,str(SCRIPT),sys.executable,
                                   str(parent),str(child),str(pidfile)],capture_output=True,timeout=10)
            self.assertEqual(result.returncode,124,result.stderr)
            pid=json.loads(pidfile.read_text())['pid']
            self.assertNotIn(pid,audit.process_table())

    def test_caller_timeout_keeps_subreaper_alive_until_detached_tree_is_cleaned(self):
        # Exercise the outer fallback independently of the supervisor's own clock.
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pidfile=root/'pid'
            command=[sys.executable,'-I','-B','-c',
                'import os,time,sys;open(sys.argv[1],"w").write(str(os.getpid()));time.sleep(100)',str(pidfile)]
            original=audit.subprocess.Popen
            def launch(argv,**options):
                process=original(argv,**options)
                communicate=process.communicate
                first=[True]
                def limited(**kwargs):
                    if first and first.pop():
                        return communicate(timeout=0.5)
                    return communicate(**kwargs)
                process.communicate=limited
                return process
            with patch.object(audit.subprocess,'Popen',launch), self.assertRaises(subprocess.TimeoutExpired):
                audit.run_supervised(command,timeout=100)
            pid=int(pidfile.read_text())
            self.assertNotIn(pid,audit.process_table())


class ScopedParserTests(unittest.TestCase):
    def test_external_diagnostics_keep_protocol_and_write_provenance_without_raw_content(self):
        records=['1<app> socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP) = 3<UDPv6:[123]>',
            '1<app> '+CONNECT.replace('connect(3,','connect(3<UDPv6:[123]>,') ,
            '1<app> write(3<UDPv6:[123]>, "SECRET_PAYLOAD", 14) = 14',
            '1<app> close(3<UDPv6:[123]>) = 0','1<app> +++ exited with 0 +++']
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace';trace.write_text('\n'.join(records)+'\n')
            _,report=audit.analyze_processes([trace],require_lifecycle=True)
        diagnostic=report['externalOperationDiagnostics'][0]
        self.assertEqual((diagnostic['straceSocketKind'],diagnostic['fd']),('udp',3))
        self.assertEqual(diagnostic['udpWriteAssociations'][0]['syscall'],'write')
        self.assertEqual(report['externalAttempts'],2)
        self.assertNotIn('SECRET_PAYLOAD',json.dumps(report))

    def test_complete_kernel_lifetime_resolves_only_known_close_return_without_claiming_closure(self):
        capture={'complete':True,'status':'captured','lostEvents':0,'pidNamespaceVerified':True,'eventCount':0,'events':[],
            'root':{'kernelPid':100},'network':{'complete':True,'eventCount':0,'events':[],
            'tasks':[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,lastOrdinal=10,
                          parentKernelPid=100) for pid,kernel in [(1,101),(100,100)]]}}
        for ending in ('close(7<anon_inode:inotify>) = ?', 'close(7<anon_inode:inotify> <unfinished ...>'):
            with self.subTest(ending=ending),tempfile.TemporaryDirectory() as directory:
                trace=Path(directory)/'trace'
                trace.write_text('1<app> execve("/owned/app", [...], 0x1) = 0\n'
                    f'1<app> {ending}\n1<app> +++ exited with 0 +++\n')
                _,report=audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)
                self.assertEqual((report['unparsedRecords'],report['classificationErrors'],report['kernelMetadataResolvedRecords']),(0,0,1))
                self.assertFalse(report['kernelMetadataResolutions'][0]['fdClosureInferred'])
                self.assertEqual(report['processes'][0]['unparsedRecordKinds'],{})
                _,strict=audit.analyze_processes([trace],require_lifecycle=True)
                self.assertEqual((strict['unparsedRecords'],strict['kernelMetadataResolvedRecords']),(1,0))

    def test_unknown_close_cannot_lose_a_tracked_ring_when_fd_annotation_is_missing(self):
        for fd,blocked,ending in ((fd,blocked,ending) for fd,blocked in ((5,True),(6,False))
                                  for ending in (') = ?', ' <unfinished ...>')):
            capture={'complete':True,'status':'captured','lostEvents':0,'pidNamespaceVerified':True,'eventCount':1,
                'events':[dict(kind='create',time=10,ctx='ring',pid=1,tgid=1,kernelPid=101,kernelTgid=101,fd=5,flags=0,sqpollKernelPid=0)],
                'root':{'kernelPid':100},'network':{'complete':True,'eventCount':0,'events':[],
                'tasks':[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,lastOrdinal=10,
                              parentKernelPid=100) for pid,kernel in [(1,101),(100,100)]]}}
            with tempfile.TemporaryDirectory() as directory:
                trace=Path(directory)/'trace';trace.write_text('1<app> execve("/owned/app", [...], 0x1) = 0\n'
                    '1<app> io_uring_setup(8, {flags=0}) = 5<anon_inode:[io_uring]>\n'
                    f'1<app> close({fd}{ending}\n1<app> +++ exited with 0 +++\n')
                _,report=audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)
                self.assertEqual(report['kernelMetadataResolvedRecords'],0 if blocked else 1)
                if blocked:self.assertIn('io_uring_descriptor_result_unknown',{issue['reason'] for issue in report['classificationIssues']})
                else:self.assertEqual(report['unparsedRecords'],0)

    def test_unlabelled_ring_alias_and_cloexec_changes_cannot_escape_unknown_close_failure(self):
        cases=[['1<app> dup(5) = 6','1<app> close(6) = ?'],
               ['1<app> fcntl(5, F_DUPFD, 0) = 6','1<app> close(6) = ?'],
               ['1<app> fcntl(5, F_SETFD, 0) = 0','1<app> execve("/owned/next", [...], 0x1) = 0',
                '1<app> close(5) = ?'],
               ['1<app> clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 2<child>',
                '2<child> unshare(CLONE_FILES) = 0','2<child> close(5<anon_inode:[io_uring]>) = 0',
                '2<child> +++ exited with 0 +++','1<app> close(5) = ?']]
        cases += [[line[:-5]+' <unfinished ...>' if line.endswith(') = ?') else line
                   for line in records] for records in cases]
        for records in cases:
            child=any(line.startswith('2<') for line in records)
            tasks=[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,lastOrdinal=10,
                        parentKernelPid=100 if pid==1 else 101) for pid,kernel in [(1,101),(100,100),*([(2,102)] if child else [])]]
            capture={'complete':True,'status':'captured','lostEvents':0,'pidNamespaceVerified':True,'eventCount':1,
                'events':[dict(kind='create',time=10,ctx='ring',pid=1,tgid=1,kernelPid=101,kernelTgid=101,fd=5,flags=0,sqpollKernelPid=0)],
                'root':{'kernelPid':100},'network':{'complete':True,'eventCount':0,'events':[],'tasks':tasks}}
            with self.subTest(records=records),tempfile.TemporaryDirectory() as directory:
                trace=Path(directory)/'trace';trace.write_text('\n'.join([
                    '1<app> execve("/owned/app", [...], 0x1) = 0',
                    '1<app> io_uring_setup(8, {flags=0}) = 5<anon_inode:[io_uring]>',*records,
                    '1<app> +++ exited with 0 +++'])+'\n')
                _,report=audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)
                self.assertEqual(report['kernelMetadataResolvedRecords'],0)
                self.assertIn('io_uring_descriptor_result_unknown',{issue['reason'] for issue in report['classificationIssues']})

    def test_unlabelled_borrowed_ring_mapping_is_still_rejected(self):
        capture={'complete':True,'status':'captured','lostEvents':0,'pidNamespaceVerified':True,'eventCount':1,
            'events':[dict(kind='create',time=10,ctx='ring',pid=1,tgid=1,kernelPid=101,kernelTgid=101,fd=5,flags=0,sqpollKernelPid=0)],
            'root':{'kernelPid':100},'network':{'complete':True,'eventCount':0,'events':[],
            'tasks':[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,lastOrdinal=10,
                          parentKernelPid=100 if pid==1 else 101) for pid,kernel in [(1,101),(2,102),(100,100)]]}}
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace';trace.write_text('\n'.join([
                '1<app> execve("/owned/app", [...], 0x1) = 0',
                '1<app> io_uring_setup(8, {flags=0}) = 5<anon_inode:[io_uring]>',
                '1<app> clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = 2<child>',
                '2<child> mmap(NULL, 4096, PROT_READ, MAP_SHARED, 5, 0) = 0x7000',
                '2<child> close(5) = 0','2<child> +++ exited with 0 +++',
                '1<app> +++ exited with 0 +++'])+'\n')
            _,report=audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)
            self.assertIn('io_uring_borrowed_ring_mapping_unsupported',{issue['reason'] for issue in report['classificationIssues']})

    def test_unparsed_kind_diagnostics_preserve_failures_without_trace_content(self):
        cases=[('close(7</private/SECRET_TRACE_PATH> <unfinished ...>', 'pending_at_end:close'),
               ('fcntl(7, F_GETFL) = ?', 'result:fcntl'),
               ('write(7<socket:[123]>, ..., 8) = 8','socket_peer:write')]
        for line,kind in cases:
            with self.subTest(kind=kind):
                scoped,_=self.parse(self.base()+['2<host> '+line,'2<host> +++ exited with 0 +++',
                                                  '1<app> +++ exited with 0 +++'],lifecycle=True)
                task=next(item for item in scoped['processes'] if item['pid']==2)
                self.assertEqual(task['unparsedRecordKinds'],{kind:1})
                self.assertEqual(scoped['unparsedRecords'],1)
                self.assertNotIn('SECRET_TRACE_PATH',json.dumps(scoped))
    def test_kernel_corroboration_discharges_only_exact_terminal_register_holes(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,
                 'eventCount':0,'events':[],'network':{'complete':True,'eventCount':0,'events':[],
                 'tasks':[{'pid':pid,'tgid':pid,'kernelPid':pid+100,'kernelTgid':pid+100,'start':1,'end':100,'lastOrdinal':10,
                           'parentKernelPid':1000 if pid==1 else 101} for pid in (1,2)]}}
        capture['root']={'kernelPid':1000,'pid':1000}
        capture['network']['tasks'].append({'pid':1000,'tgid':1000,'kernelPid':1000,'kernelTgid':1000,'start':1,'end':100,'lastOrdinal':0})
        for ending in ('+++ killed by SIGKILL +++','+++ exited with 0 +++'):
            for signals in (False,True):
                for hidden_network in (False,True):
                    with self.subTest(ending=ending,signals=signals,hidden=hidden_network),tempfile.TemporaryDirectory() as directory:
                        capture['network'].update(events=[],eventCount=0)
                        trace=Path(directory)/'trace'
                        lines=self.base()+['2<host> ???( <unfinished ...>']
                        if signals:lines+=['2<host> --- SIGTERM {si_signo=SIGTERM, si_code=SI_USER} ---']
                        lines+=['2<host> <... ??? resumed>) = ?', '2<host> '+ending,'1<app> +++ exited with 0 +++']
                        trace.write_text('\n'.join(lines)+'\n')
                        if hidden_network:
                            capture['network']['events']=[{'kind':'H','time':10,'pid':2,'tgid':2,
                                'kernelPid':102,'kernelTgid':102,'call':0,'ordinal':0,'value':7,'result':10}]
                            capture['network']['eventCount']=1
                        scoped,whole=audit.analyze_processes([trace],(HOST,),(HOST,),True,capture)
                        self.assertEqual(scoped['kernelResolvedRecords'],0 if hidden_network else 2)
                        self.assertEqual(whole['kernelResolvedRecords'],scoped['kernelResolvedRecords'])
                        self.assertEqual(scoped['unparsedRecords']>0,hidden_network)
        capture['network'].update(events=[],eventCount=0)
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace'
            trace.write_text('\n'.join(self.base()+['2<host> ???( <unfinished ...>',
                '1<app> +++ exited with 0 +++'])+'\n')
            scoped,_=audit.analyze_processes([trace],(HOST,),(HOST,),True,capture)
            self.assertGreater(scoped['unparsedRecords'],0)
            self.assertEqual(scoped['kernelResolvedRecords'],0)

    def parse(self, lines, roots=(HOST, PYTHON), required=(HOST,), lifecycle=False):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'network.trace'
            trace.write_text('\n'.join(lines) + '\n')
            return audit.analyze_processes([trace], roots, required, lifecycle)

    def test_pending_known_write_result_is_recovered_only_by_terminal_kernel_proof(self):
        capture={'complete':True,'status':'captured','lostEvents':0,'pidNamespaceVerified':True,'events':[],'eventCount':0,
            'root':{'kernelPid':100},'network':{'complete':True,'eventCount':1,
            'events':[dict(kind='P',time=3,pid=1,tgid=1,kernelPid=101,kernelTgid=101,call=5,ordinal=1,value=3,result=0)],
            'tasks':[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,lastOrdinal=1,
                          parentKernelPid=100) for pid,kernel in [(1,101),(100,100)]]}}
        for ending in ('write(3,  <unfinished ...>','write(3, ..., 1) = ?'):
            with tempfile.TemporaryDirectory() as directory:
                trace=Path(directory)/'trace';trace.write_text('\n'.join([
                    '1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0',
                    '1<app> '+ending,'1<app> +++ killed by SIGKILL +++'])+'\n')
                _,whole=audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)
                self.assertEqual(whole['unparsedRecords'],0)
                self.assertEqual(whole['kernelResolvedResultFields'],1)
                self.assertFalse(any(task['unparsedRecordKinds'] for task in whole['processes']))
                _,strict=audit.analyze_processes([trace],require_lifecycle=True)
                self.assertGreater(strict['unparsedRecords'],0)

    def test_pending_sendto_final_null_peer_requires_an_interpreted_fd_peer(self):
        capture={'complete':True,'status':'captured','lostEvents':0,'pidNamespaceVerified':True,'events':[],'eventCount':0,
            'root':{'kernelPid':100},'network':{'complete':True,'eventCount':1,
            'events':[dict(kind='P',time=3,pid=1,tgid=1,kernelPid=101,kernelTgid=101,call=2,ordinal=1,value=3,result=0)],
            'tasks':[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,lastOrdinal=1,
                          parentKernelPid=100) for pid,kernel in [(1,101),(100,100)]]}}
        for peer,valid in [('UNIX-STREAM:[42->43]',True),('TCP:[127.0.0.1:4000->127.0.0.1:4001]',True),('socket:[42]',False)]:
            with tempfile.TemporaryDirectory() as directory:
                trace=Path(directory)/'trace';trace.write_text('\n'.join([
                    '1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0',
                    f'1<app> sendto(3<{peer}>, ..., 1, 0, NULL, 0 <unfinished ...>',
                    '1<app> +++ killed by SIGKILL +++'])+'\n')
                _,whole=audit.analyze_processes([trace],require_lifecycle=True,kernel_capture=capture)
                self.assertEqual(whole['unparsedRecords']==0,valid)

    def base(self):
        return ['1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0',
                '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 2<host>',
                f'2<host> execve("{HOST}", [...], 0x1 /* 1 var */) = 0']

    def test_only_selected_roots_and_descendants_are_enforced(self):
        scoped, whole = self.parse(self.base() + [
            f'2<host> {LOCAL}',
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>',
            '3<renderer> execve("/owned/renderer", [...], 0x1 /* 1 var */) = 0',
            f'3<renderer> {CONNECT}',
            '3<renderer> connect(4, <unfinished ...>'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (0, 0))
        self.assertEqual((whole['externalAttempts'], whole['unparsedRecords']), (1, 1))
        self.assertFalse(next(p for p in whole['processes'] if p['pid'] == 3)['inScope'])

    def test_reexec_renamed_reparented_child_stays_in_scope(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=CLONE_PARENT|SIGCHLD) = 3<native>',
            '3<native> execve("/owned/other-program", [...], 0x1 /* 1 var */) = 0',
            '3<renamed> clone(child_stack=NULL, flags=CLONE_THREAD) = 4<worker>',
            f'4<worker> {CONNECT}'])
        self.assertEqual(scoped['externalAttempts'], 1)
        self.assertEqual(scoped['external'][0]['pid'], 4)
        self.assertEqual(scoped['unparsedRecords'], 0)

    def test_independent_native_helper_is_an_additional_root(self):
        scoped, _ = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<native>',
            f'3<native> execve("{PYTHON}", [...], 0x1 /* 1 var */) = 0',
            f'3<native> {CONNECT}'])
        self.assertEqual(scoped['rootPids'], [2, 3])
        self.assertEqual(scoped['externalAttempts'], 1)

    def test_same_comm_or_basename_is_not_a_root(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<host>',
            '3<host> execve("/unselected/aelix-studio-host", [...], 0x1 /* 1 var */) = 0',
            f'3<host> {CONNECT}'])
        self.assertEqual(scoped['externalAttempts'], 0)
        self.assertEqual(whole['externalAttempts'], 1)

    def test_missing_root_fork_edge_or_unknown_exec_fails_closed(self):
        for lines in [self.base()[:1], self.base() + [f'3<orphan> {CONNECT}'],
                      self.base() + ['2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<native>',
                                     '3<native> execve("./unknown", [...], 0x1 /* 1 var */) = 0']]:
            with self.subTest(lines=lines):
                scoped, _ = self.parse(lines)
                self.assertGreater(scoped['unparsedRecords'], 0)

    def test_unfinished_scoped_network_call_is_not_dropped(self):
        scoped, _ = self.parse(self.base() + ['2<host> connect(4, <unfinished ...>'])
        self.assertEqual(scoped['unparsedRecords'], 1)

    def test_interleaved_fork_and_exec_resumption_preserves_edges(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=CLONE_VFORK|SIGCHLD <unfinished ...>',
            '3<native> execve("/owned/other", [...], 0x1 /* 1 var */ <unfinished ...>',
            '2<host> <... clone resumed>) = 3<native>',
            '3<native> <... execve resumed>) = 0', f'3<native> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))

    def test_proc_self_exec_uses_inherited_image_not_comm_or_auditor(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<host>',
            '3<host> execve("/proc/self/exe", [...], 0x1 /* 1 var */) = 0',
            f'3<host> {CONNECT}',
            '2<host> clone(child_stack=NULL, flags=SIGCHLD) = 4<renderer>',
            '4<renderer> execve("/proc/self/exe", [...], 0x1 /* 1 var */) = 0',
            f'4<renderer> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
        self.assertEqual(whole['externalAttempts'], 2)
        self.assertEqual(scoped['rootPids'], [2, 4])

    def test_inherited_connected_socket_peer_is_not_exempt(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> sendto(8<TCP:[127.0.0.1:123->203.0.113.1:443]>, ""..., 3, 0, NULL, 0) = 3',
            '2<host> sendmsg(9<UDPv6:[[::1]:123->[::1]:53]>, {msg_name=NULL, msg_iov=[...]}, 0) = 3'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (2, 1))
        self.assertIn('udp_write_untracked_fd', {i['reason'] for i in scoped['classificationIssues']})

    def test_unknown_socket_peer_and_abbreviated_vector_are_incomplete(self):
        for line in ['sendto(8<socket:[123]>, ""..., 3, 0, NULL, 0) = 3',
                     'sendmmsg(8, [...], 2, 0) = 2']:
            with self.subTest(line=line):
                scoped, _ = self.parse(self.base() + ['2<host> ' + line])
                self.assertGreater(scoped['unparsedRecords'], 0)

    def test_missing_child_and_truncated_lifecycle_fail_closed(self):
        scoped, _ = self.parse(self.base() + ['2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<lost>'])
        self.assertGreater(scoped['classificationErrors'], 0)
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory)/'trace'
            trace.write_text('1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0\n')
            _scoped, whole = audit.analyze_processes([trace], require_lifecycle=True)
            self.assertGreater(whole['unparsedRecords'], 0)

    def test_namespaced_fork_return_uses_tracer_pid_without_colliding(self):
        scoped, _ = self.parse(self.base() + [
            "2<host> clone(child_stack=NULL, flags=CLONE_NEWPID|SIGCHLD) = 2<worker> /* 99 in strace's PID NS */",
            '99<worker> execve("/owned/worker", [...], 0x1 /* 1 var */) = 0',
            f'99<worker> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
        self.assertEqual(next(p for p in scoped['processes'] if p['pid'] == 99)['parentPid'], 2)

    def test_classification_diagnostics_preserve_failure_without_trace_secrets(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<lost>',
            '4<orphan> execve("./SYNTHETIC_PATH_SECRET", [...], 0x1 /* 1 var */) = 0'])
        self.assertEqual(scoped['classificationErrors'], len(scoped['classificationIssues']))
        self.assertEqual({issue['reason'] for issue in scoped['classificationIssues']},
                         {'relative_exec_filename', 'missing_child_records', 'missing_fork_edge'})
        self.assertNotIn('SYNTHETIC_PATH_SECRET', json.dumps(scoped))

    def test_killed_sibling_register_decode_stub_remains_in_its_own_tree(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>',
            '3<renderer> ???( <unfinished ...>',
            '3<renderer> +++ killed by SIGTERM +++',
            '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (0, 0))
        self.assertEqual((whole['classificationErrors'], whole['unparsedRecords']), (0, 1))
        self.assertEqual(next(p for p in whole['processes'] if p['pid'] == 3)['unparsedRecords'], 1)

    def test_same_terminal_stub_inside_selected_tree_still_fails(self):
        for lines in [self.base() + ['2<host> ???( <unfinished ...>', '2<host> +++ killed by SIGTERM +++'],
                      self.base() + ['2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<renamed>',
                                     '3<renamed> ???( <unfinished ...>', '3<renamed> +++ killed by SIGKILL +++',
                                     '2<host> +++ exited with 0 +++']]:
            with self.subTest(lines=lines):
                scoped, _ = self.parse(lines + ['1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertEqual(scoped['unparsedRecords'], 1)

    def test_terminal_stub_never_hides_missing_ancestry_or_lifecycle(self):
        for extra in [
            ['3<orphan> ???( <unfinished ...>', '3<orphan> +++ killed by SIGTERM +++'],
            ['1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>', '3<renderer> ???( <unfinished ...>'],
        ]:
            with self.subTest(extra=extra):
                scoped, _ = self.parse(self.base() + extra + [
                    '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertGreater(scoped['classificationErrors'], 0)

    def test_only_exact_final_stub_with_signal_death_is_attributable(self):
        for extra in [
            ['3<renderer> ???( <unfinished ...>', '3<renderer> +++ exited with 0 +++'],
            ['3<renderer> ???( <unfinished ...>', f'3<renderer> {CONNECT}', '3<renderer> +++ killed by SIGTERM +++'],
            ['3<renderer> ???( <unfinished ...>', '3<renderer> ???( <unfinished ...>', '3<renderer> +++ killed by SIGTERM +++'],
            ['3<renderer> ???( <unfinished ...>', '3<renderer> +++ killed by SIGTERM +++', '3<renderer> +++ killed by SIGTERM +++'],
            ['3<renderer> ???(NULL) = 0', '3<renderer> +++ killed by SIGTERM +++'],
        ]:
            with self.subTest(extra=extra):
                scoped, _ = self.parse(self.base() + [
                    '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>', *extra,
                    '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertGreater(scoped['classificationErrors'], 0)

    def test_pending_fork_or_exec_is_fatal_even_for_killed_sibling(self):
        for call in ['clone(child_stack=NULL, flags=SIGCHLD', 'execve("/unknown/image", [...], 0x1']:
            with self.subTest(call=call):
                scoped, _ = self.parse(self.base() + [
                    '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<renderer>',
                    '3<renderer> ' + call + ' <unfinished ...>',
                    '3<renderer> ???( <unfinished ...>', '3<renderer> +++ killed by SIGTERM +++',
                    '2<host> +++ exited with 0 +++', '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertGreater(scoped['classificationErrors'], 0)

    def test_io_uring_is_classified_inside_selected_tree_including_failed_calls(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> io_uring_setup(2, {...}) = -1 EPERM (Operation not permitted)',
            '2<host> io_uring_enter(9, 1, 1, 0, NULL, 8) = -1 EBADF (Bad file descriptor)',
            '2<host> io_uring_register(9, 0, NULL, 0) = -1 EBADF (Bad file descriptor)'])
        self.assertEqual(scoped['externalAttempts'], 0)
        self.assertEqual(scoped['classificationErrors'], 3)
        self.assertEqual({i['syscall'] for i in scoped['classificationIssues']},
                         {'io_uring_setup', 'io_uring_enter', 'io_uring_register'})

    def test_io_uring_of_known_sibling_is_retained_only_in_whole_report(self):
        scoped, whole = self.parse(self.base() + [
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3<sibling>',
            '3<sibling> io_uring_setup(2, {...}) = 9'])
        self.assertEqual(scoped['classificationErrors'], 0)
        self.assertEqual(whole['classificationErrors'], 1)
        self.assertEqual(next(p for p in whole['processes'] if p['pid'] == 3)['ioUringSyscalls'], ['io_uring_setup'])

    def test_unfinished_io_uring_in_selected_child_never_becomes_zero(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=SIGCHLD) = 3<renamed>',
            '3<renamed> io_uring_enter(9, 1, 1, 0, NULL, 8 <unfinished ...>'])
        self.assertEqual(scoped['classificationErrors'], 1)

    def test_only_loopback_accepted_socket_can_precede_allowed_ring_writes(self):
        for address,expected in [('127.0.0.1',0),('203.0.113.1',1)]:
            with self.subTest(address=address):
                accepted=f'accept4(3, {{sa_family=AF_INET, sin_port=htons(12345), sin_addr=inet_addr("{address}")}}, [16], SOCK_CLOEXEC) = 5'
                scoped,_=self.parse(self.base()+['2<host> '+accepted])
                self.assertEqual(scoped['classificationErrors'],expected)
        scoped,_=self.parse(self.base()+['2<host> accept4(3, NULL, NULL, 0) = 5<socket:[123]>'])
        self.assertEqual(scoped['unparsedRecords'],1)

    def test_numeric_setup_flags_with_strace_comments_match_kernel_creation(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,'eventCount':2,
                 'events':[{'kind':'create','time':1,'ctx':'opaque','pid':2,'tgid':2,'fd':5,'flags':65536},
                           {'kind':'submit','time':2,'ctx':'opaque','pid':2,'tgid':2,'opcode':29,'sqpoll':False}]}
        capture['network']={'complete':True,'events':[],'eventCount':0,
                            'tasks':[{'pid':pid,'tgid':pid,'kernelPid':pid,'kernelTgid':pid,'start':1,'end':10,'lastOrdinal':10,
                                      'parentKernelPid':1000 if pid==1 else 1} for pid in (1,2)]}
        capture['root']={'kernelPid':1000,'pid':1000}
        capture['network']['tasks'].append({'pid':1000,'tgid':1000,'kernelPid':1000,'kernelTgid':1000,'start':1,'end':10,'lastOrdinal':0})
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace'
            trace.write_text('\n'.join(self.base()+[
                '2<host> io_uring_setup(256, {flags=0x10000 /* IORING_SETUP_??? */}) = 5<anon_inode:[io_uring]>',
                '2<host> io_uring_enter(5<anon_inode:[io_uring]>, 1, 0, 0, NULL, 8) = 1'])+'\n')
            scoped,_=audit.analyze_processes([trace],(HOST,),(HOST,),False,capture)
        self.assertEqual(scoped['classificationIssues'],[])
        self.assertEqual(scoped['ioUring']['opcodeCounts'],{'EPOLL_CTL':1})

    def test_paired_capture_does_not_erase_unfinished_ring_syscall(self):
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,'eventCount':0,'events':[]}
        with tempfile.TemporaryDirectory() as directory:
            trace=Path(directory)/'trace'
            trace.write_text('\n'.join(self.base()+['2<host> io_uring_setup(8, <unfinished ...>'])+'\n')
            scoped,_=audit.analyze_processes([trace],(HOST,),(HOST,),False,capture)
        self.assertGreater(scoped['classificationErrors'],0)

    def test_c_escaped_unicode_path_matches_without_disclosing_path(self):
        from outboundScope import decode_path
        self.assertEqual(decode_path(r'"/owned/\355\225\234\352\270\200"'), '/owned/한글')
        scoped, _ = self.parse(self.base())
        self.assertNotIn(HOST, json.dumps(scoped))


@unittest.skipUnless(sys.platform == 'linux', 'Linux process tracing required')
class ScopedTraceTests(unittest.TestCase):
    def setUp(self):
        self.captured_stdout=io.StringIO()
        output=redirect_stdout(self.captured_stdout)
        output.__enter__();self.addCleanup(output.__exit__,None,None,None)

    def test_capture_timeout_stops_the_real_trace_and_detached_app_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);pidfile=root/'child-pid'
            child='import os,signal,time,sys;signal.signal(signal.SIGTERM,signal.SIG_IGN);open(sys.argv[1],"w").write(str(os.getpid()));time.sleep(100)'
            driver='import subprocess,sys,time;subprocess.Popen([sys.executable,"-I","-B","-c",sys.argv[1],sys.argv[2]],start_new_session=True);time.sleep(100)'
            original_start=audit.Capture.start
            def start(capture,pid):
                original_start(capture,pid)
                audit.signal.setitimer(audit.signal.ITIMER_REAL,1)
            path=root/'timeout.json'
            with patch.object(audit.Capture,'start',start), patch.object(audit,'SUPERVISOR_CLEANUP',0.2):
                code=audit.audit([sys.executable,'-I','-B','-c',driver,child,str(pidfile)],path,capture_timeout=30)
            report=json.loads(path.read_text())
            self.assertEqual((code,report['recaptures']), (87,0))
            self.assertEqual(report['ioUring']['capture']['reason'],'capture_timeout')
            pid=int(pidfile.read_text())
            self.assertTrue(pid not in audit.process_table() or audit.process_table()[pid][2]=='Z')

    def test_forced_incomplete_real_capture_recaptures_once_then_fails(self):
        original_stop=audit.Capture.stop
        stops=[]
        def lose_evidence(capture):
            evidence=original_stop(capture)
            stops.append(evidence.get('complete'))
            evidence.update(complete=False,status='failed',reason='kernel_bpf_program_recursion_lost',
                programLoss={'stage':'after-detach','programs':[{'programName':'ip_local_out','recursion_misses':1}]})
            return evidence
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'incomplete.json'
            with patch.object(audit.Capture, 'stop', lose_evidence):
                code=audit.audit(['/bin/true'],path)
            self.assertEqual(self.captured_stdout.getvalue().count('::warning title=Outbound audit recapture::'),1)
            report=json.loads(path.read_text())
            self.assertEqual(stops,[True,True], 'Injection requires two otherwise complete real captures')
            self.assertEqual((code,report['recaptures'],len(report['captureAttempts'])), (87,1,2))

    def test_real_external_control_is_still_denied_without_recapture(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'control.json'
            with patch.object(audit, 'capture_once', wraps=audit.capture_once) as run:
                code=audit.audit([sys.executable,'-I','-B',str(SCRIPT),'--positive-control'],path)
            report=json.loads(path.read_text())
            self.assertEqual((code,report['externalAttempts'],report['unparsedRecords']), (86,2,0))
            self.assertEqual(run.call_count,1)

    @classmethod
    def setUpClass(cls):
        if not shutil.which('strace') or not shutil.which('cc'):
            raise RuntimeError('Scoped Linux integration tests require strace and cc')

    def test_real_io_uring_connect_cannot_pass_as_zero_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'uring.c'
            source.write_text('''#define _GNU_SOURCE
#include <unistd.h>
#include <sys/syscall.h>
#include <linux/io_uring.h>
#include <sys/socket.h>
#include <arpa/inet.h>
#ifdef USE_LIBURING
#include <liburing.h>
#endif
int main(void) {
#ifdef USE_LIBURING
    struct io_uring ring;
    if (io_uring_queue_init(2, &ring, 0) == 0) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in address = {.sin_family=AF_INET,.sin_port=htons(9)};
        inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        io_uring_prep_connect(io_uring_get_sqe(&ring), fd, (void*)&address, sizeof(address));
        io_uring_submit(&ring);
        struct io_uring_cqe *completion;
        if (io_uring_wait_cqe(&ring, &completion) == 0) io_uring_cqe_seen(&ring, completion);
        close(fd); io_uring_queue_exit(&ring);
    }
#else
    struct io_uring_params params = {0};
    long fd = syscall(SYS_io_uring_setup, 2, &params);
    if (fd >= 0) close(fd);
#endif
    syscall(SYS_io_uring_enter, -1, 0, 0, 0, 0, 0);
    syscall(SYS_io_uring_register, -1, 0, 0, 0);
    return 0;
}
''')
            binary = root/'uring-control'
            linked = shutil.which('pkg-config') and subprocess.run(['pkg-config','--exists','liburing']).returncode == 0
            flags = ['-DUSE_LIBURING','-luring'] if linked else []
            subprocess.run(['cc',str(source),'-o',str(binary),*flags],check=True)
            result = subprocess.run([sys.executable,'-B',str(SCRIPT),'--report',str(root/'report.json'),
                                     '--scope-executable',str(binary),'--require-executable',str(binary),
                                     '--',str(binary)],capture_output=True,text=True,timeout=30)
            report = json.loads((root/'report.json').read_text())
            self.assertEqual(result.returncode,87,result.stderr)
            self.assertGreaterEqual(report['classificationErrors'],1)
            self.assertEqual(report['externalAttempts'],0)

    def test_real_different_executable_child_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'control.c'
            source.write_text('#include <sys/socket.h>\n#include <arpa/inet.h>\n#include <unistd.h>\n'
                              'int main(){struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(9)};'
                              'inet_pton(AF_INET,"203.0.113.1",&a.sin_addr);'
                              'int s=socket(AF_INET,SOCK_DGRAM,0);'
                              'sendto(s,"",0,0,(void*)&a,sizeof(a));close(s);return 0;}\n')
            worker = root / 'native-control'
            subprocess.run(['cc', str(source), '-o', str(worker)], check=True)
            selected = Path(sys.executable).resolve()
            # A different executable launched by Python must remain inside its tree.
            shell = root / 'run.sh'
            shell.write_text(f'#!/bin/sh\nexec {selected} -c "import subprocess;subprocess.run([\'{worker}\'])" SYNTHETIC_ARGUMENT_SECRET\n')
            env = dict(os.environ, SYNTHETIC_ENV_SECRET='synthetic-value')
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--report', str(root/'scoped.json'),
                                     '--scope-executable', str(selected), '--require-executable', str(selected),
                                     '--whole-report', str(root/'whole.json'), '--', '/bin/sh', str(shell)],
                                    env=env, capture_output=True, text=True, timeout=30)
            scoped = json.loads((root/'scoped.json').read_text())
            whole = json.loads((root/'whole.json').read_text())
            self.assertEqual(result.returncode, 86, result.stderr)
            self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
            self.assertEqual(whole['externalAttempts'], 1)
            self.assertNotIn('SYNTHETIC_ARGUMENT_SECRET', json.dumps(whole))
            self.assertNotIn('SYNTHETIC_ENV_SECRET', json.dumps(whole))

    def test_zero_selected_tree_and_external_sibling_do_not_share_a_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Select /bin/true, while Python's explicit control is a sibling, not its child.
            driver = root/'driver.py'
            driver.write_text('import subprocess,sys\nsubprocess.run(["/bin/true"])\n'
                              'subprocess.run([sys.executable,"-I","-B",sys.argv[1],"--positive-control"])\n')
            result = subprocess.run([sys.executable, '-B', str(SCRIPT), '--report', str(root/'scoped.json'),
                                     '--scope-executable', '/bin/true', '--require-executable', '/bin/true',
                                     '--whole-report', str(root/'whole.json'), '--', sys.executable, '-I', '-B', str(driver), str(SCRIPT)],
                                    capture_output=True, text=True, timeout=30)
            scoped = json.loads((root/'scoped.json').read_text()); whole = json.loads((root/'whole.json').read_text())
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (0, 0))
            self.assertEqual(whole['externalAttempts'], 2)


    def test_trace_suppresses_argument_and_environment_sentinels(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory)/'report.json'
            original = audit.analyze_processes
            inspected = []
            def inspect(paths, *args):
                raw = ''.join(path.read_text() for path in paths)
                self.assertNotIn('SYNTHETIC_ARGUMENT_SECRET', raw)
                self.assertNotIn('SYNTHETIC_ENV_SECRET', raw)
                inspected.append(True)
                return original(paths, *args)
            with patch.object(audit, 'analyze_processes', inspect), patch.dict(os.environ, SYNTHETIC_ENV_SECRET='hidden'):
                result = audit.audit(['/bin/true','SYNTHETIC_ARGUMENT_SECRET'], report)
            self.assertEqual(result, 0)
            self.assertTrue(inspected)


    def test_real_inherited_udp_socket_and_message_vector_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'worker.c'
            source.write_text('#define _GNU_SOURCE\n#include <sys/socket.h>\n#include <stdlib.h>\n#include <unistd.h>\n'
                              'int main(int argc,char **argv){int fd=atoi(argv[1]);'
                              'struct iovec iov={.iov_base="SYNTHETIC_PAYLOAD_SECRET",.iov_len=24};'
                              'struct mmsghdr m[2]={0};'
                              'for(int i=0;i<2;i++){m[i].msg_hdr.msg_iov=&iov;m[i].msg_hdr.msg_iovlen=1;}'
                              'sendmmsg(fd,m,2,0);close(fd);return 0;}\n')
            worker = root/'worker'
            subprocess.run(['cc',str(source),'-o',str(worker)],check=True)
            driver = root/'driver.py'
            # Use an owned UDP receiver on this machine's non-loopback interface.
            # This is external under the audit policy, without relying on remote replies.
            driver.write_text('import fcntl,os,socket,sys\nfrom multiprocessing import get_context\n'
                              'ready=get_context("fork").Semaphore(0)\n'
                              's=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\n'
                              's.connect(("203.0.113.1",9))\n'
                              'ip=s.getsockname()[0]\n'
                              'receiver=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\n'
                              'receiver.bind((ip,0))\n'
                              's.connect(receiver.getsockname())\n'
                              'fcntl.fcntl(s.fileno(),fcntl.F_SETFD,0)\n'
                              'child=os.fork()\n'
                              'if child==0:\n'
                              ' ready.acquire()\n'
                              ' os.execv(sys.argv[1],[sys.argv[1],str(s.fileno())])\n'
                              'ready.release()\n'
                              '_,status=os.waitpid(child,0)\n'
                              'assert status==0\ns.close();receiver.close()\n')
            from unittest.mock import patch
            original = audit.analyze_processes
            def inspect(paths, *args):
                self.assertNotIn('SYNTHETIC_PAYLOAD_SECRET', ''.join(path.read_text() for path in paths))
                return original(paths, *args)
            with patch.object(audit, 'analyze_processes', inspect):
                result = audit.audit([sys.executable,'-I','-B',str(driver),str(worker)], root/'scoped.json',
                                     scope_executables=(worker,), require_executables=(worker,), whole_report_path=root/'whole.json')
            scoped = json.loads((root/'scoped.json').read_text())
            self.assertEqual(result,87)
            self.assertEqual(scoped['externalAttempts'],2)
            self.assertIn('udp_socket_cross_scope',{issue['reason'] for issue in scoped['classificationIssues']})


    def test_real_loopback_accepted_and_connected_sockets_remain_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            driver = root/'loopback.py'
            driver.write_text('import socket,threading\n'
                              'server=socket.socket();server.bind(("127.0.0.1",0));server.listen()\n'
                              'def respond():\n'
                              ' c,_=server.accept();c.recv(10);c.sendall(b"reply");c.close()\n'
                              'thread=threading.Thread(target=respond);thread.start()\n'
                              'client=socket.create_connection(server.getsockname());client.sendall(b"request")\n'
                              'assert client.recv(10)==b"reply"\n'
                              'client.close();thread.join();server.close()\n')
            result = subprocess.run([sys.executable,'-B',str(SCRIPT),'--report',str(root/'scoped.json'),
                                     '--scope-executable',sys.executable,'--require-executable',sys.executable,
                                     '--',sys.executable,'-I','-B',str(driver)],capture_output=True,text=True,timeout=30)
            scoped = json.loads((root/'scoped.json').read_text())
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual((scoped['externalAttempts'],scoped['unparsedRecords']),(0,0))
            self.assertGreater(scoped['destinationAttempts'],0)


class TracerSelectionTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('strace'), 'Linux audit runtime test')
    def test_receiving_socket_data_does_not_create_an_unmatched_send_operation(self):
        import socket
        import threading
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);endpoint=root/'local.sock';report=root/'report.json'
            server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            server.bind(str(endpoint));server.listen();server.settimeout(0.1)
            stop=threading.Event()
            def serve():
                while not stop.is_set():
                    try:connection,_=server.accept()
                    except socket.timeout:continue
                    except OSError:return
                    with connection:connection.sendall(b'control')
                    return
            worker=threading.Thread(target=serve);worker.start()
            try:
                code='import socket,os,sys;s=socket.socket(socket.AF_UNIX);s.connect(sys.argv[1]);assert s.recvmsg(3)[0]==b"con";assert os.readv(s.fileno(),[bytearray(4)])==4;s.close()'
                result=audit.audit([sys.executable,'-I','-B','-c',code,str(endpoint)],report)
                data=json.loads(report.read_text())
                self.assertEqual(result,0)
                self.assertEqual((data['externalAttempts'],data['unparsedRecords'],data['classificationErrors']),(0,0,0))
                self.assertTrue(data['kernelNetwork']['recorded'])
            finally:
                stop.set();server.close();worker.join(timeout=5)

    def test_pinned_binary_is_selected_without_relying_on_sudo_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);binary=root/'.local/strace-toolchain/bin/strace'
            binary.parent.mkdir(parents=True);binary.write_text('fixture')
            with patch.object(audit.shutil,'which',return_value='/usr/bin/strace'):
                self.assertEqual(audit.resolve_strace(root),str(binary))

    def test_unsupported_abi_diagnostic_is_detected_without_retaining_contents(self):
        warning='strace: WARNING: Proper structure decoding for this personality is not supported, please consider building strace with mpers support enabled.'
        self.assertEqual(audit.unsupported_personalities(warning),1)
        self.assertEqual(audit.unsupported_personalities('normal synthetic application diagnostics'),0)

    @unittest.skipUnless(sys.platform == 'linux' and shutil.which('strace'), 'Linux audit runtime test')
    def test_unsupported_personality_warning_blocks_an_otherwise_successful_command(self):
        with tempfile.TemporaryDirectory() as directory:
            report=Path(directory)/'report.json'
            warning='strace: WARNING: Proper structure decoding for this personality is not supported, please consider building strace with mpers support enabled.'
            code=audit.audit([sys.executable,'-I','-B','-c','import sys;sys.stderr.write('+repr(warning+'\n')+')'],report)
            data=json.loads(report.read_text())
            self.assertEqual(code,87)
            self.assertEqual(data['straceDiagnostics']['unsupportedPersonalities'],1)
            self.assertIn({'reason':'unsupported_strace_personality'},data['classificationIssues'])


class TaskEvidenceReportTests(unittest.TestCase):
    fixture = staticmethod(task_capture_fixture)

    def parse(self,lines,capture=None,selected=()):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'trace';path.write_text('\n'.join(lines)+'\n')
            scoped, whole, summarize = audit.measure_processes([path],selected,(),True,capture)
            scoped['taskEvidence'], whole['taskEvidence'] = summarize()
            return scoped, whole

    def task(self,report,tid=1):
        return next(row for row in report['taskEvidence']['straceTasks'] if row['tid']==tid)

    def test_observed_close_and_register_syntax_survives_existing_resolution_without_contents(self):
        lines=['1<app> execve("/Users/SECRET_TRACE/app", ["SECRET_ARG"], ["SECRET_ENV"]) = 0',
               '1<app> close(7</Users/SECRET_TRACE/file>) = ?',
               '1<app> ???( <unfinished ...>','1<app> <... ??? resumed>) = ?',
               '1<app> +++ exited with 0 +++']
        _,report=self.parse(lines,self.fixture());row=self.task(report)
        self.assertEqual((report['unparsedRecords'],report['kernelResolvedRecords'],report['kernelMetadataResolvedRecords']),(0,2,1))
        self.assertEqual((row['existingRegisterResolutions'],row['existingCloseResolutions']),(2,1))
        self.assertEqual(row['positions'],dict(firstSequence=1,lastSequence=5,records=5))
        self.assertEqual({gap['kind'] for gap in row['gaps']},{'register-sequence','close-return-unavailable'})
        stub = next(gap for gap in row['gaps'] if gap['kind']=='register-sequence')
        self.assertTrue(stub['terminalDelimited'] and stub['exactStubSyntax'])
        self.assertNotIn('SECRET',json.dumps(report))
        self.assertFalse(report['kernelMetadataResolutions'][0]['fdClosureInferred'])
        self.assertFalse(report['kernelMetadataResolutions'][0]['returnValueKnown'])

    def test_unknown_record_still_globally_blocks_existing_close_resolution(self):
        capture=self.fixture();capture['network']['tasks'].append(dict(pid=2,tgid=2,kernelPid=102,
            kernelTgid=102,parentKernelPid=101,start=1,end=100,lastOrdinal=0,kernelThread=False,ioWorker=False))
        _,report=self.parse(['1<app> execve("/owned/app", [...], 0x1) = 0',
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 2','1<app> close(7) = ?',
            '2<child> ??? SECRET_TRACE','2<child> +++ exited with 0 +++','1<app> +++ exited with 0 +++'],capture)
        self.assertEqual(report['kernelMetadataResolvedRecords'],0)
        self.assertGreater(report['unparsedRecords'],0)
        row=self.task(report,2)
        self.assertEqual(row['gaps'],[dict(kind='unclassified-record',records=1,sequence=4,
            recordLength=len('??? SECRET_TRACE'),recordShape='register_unavailable')])
        self.assertEqual(report['classificationIssues'][row['classificationIssueIndices'][0]]['reason'],'unknown_record')
        self.assertNotIn('SECRET',json.dumps(report))

    def test_pending_and_inexact_close_syntax_are_distinct_without_accepting_more(self):
        for text,shape in [('close(7<anon_inode:inotify> <unfinished ...>','close-pending-complete-argument'),
                           ('close(7<incomplete <unfinished ...>','other-result-gap')]:
            with self.subTest(text=text):
                _,report=self.parse(['1<app> '+text,'1<app> +++ exited with 0 +++'],self.fixture())
                gap=self.task(report)['gaps'][0]
                self.assertEqual(gap['kind'],shape)
                self.assertTrue(gap['pendingAtCaptureEnd'])
                if shape=='other-result-gap':
                    self.assertEqual(report['kernelMetadataResolvedRecords'],0)
                    self.assertGreater(report['unparsedRecords'],0)

    def test_orphan_register_resume_is_not_described_as_a_terminal_delimited_stub(self):
        _,report=self.parse(['1<app> <... ??? resumed>) = ?','1<app> +++ exited with 0 +++'],self.fixture())
        self.assertFalse(self.task(report)['gaps'][0]['terminalDelimited'])
        self.assertGreater(report['unparsedRecords'],0)

    def test_terminal_boundary_does_not_validate_duplicate_resume_or_intervening_syscall(self):
        for invalid in ('<... ??? resumed>) = ?', 'close(7) = 0'):
            with self.subTest(invalid=invalid):
                _,report=self.parse(['1<app> ???( <unfinished ...>', '1<app> <... ??? resumed>) = ?',
                    f'1<app> {invalid}', '1<app> +++ exited with 0 +++'],self.fixture())
                gap=self.task(report)['gaps'][0]
                self.assertTrue(gap['terminalDelimited'])
                self.assertFalse(gap['exactStubSyntax'])
                self.assertGreater(report['unparsedRecords'],0)

    def test_kernel_child_without_strace_has_numeric_identity_even_for_global_issue(self):
        for fork_known in (False,True):
            with self.subTest(fork_known=fork_known):
                capture=self.fixture();capture['network']['tasks'].append(dict(pid=3,tgid=3,kernelPid=103,
                    kernelTgid=103,parentKernelPid=101,start=2,end=90,lastOrdinal=0,kernelThread=False,ioWorker=False))
                lines=['1<app> execve("/owned/app", [...], 0x1) = 0']
                if fork_known:lines+=['1<app> clone(child_stack=NULL, flags=SIGCHLD) = 3']
                _,report=self.parse(lines+['1<app> +++ exited with 0 +++'],capture)
                child=next(row for row in report['taskEvidence']['tasks'] if row['namespaceTid']==3)
                self.assertEqual((child['kernelTid'],child['parentNamespaceTid']),(103,1))
                self.assertFalse(child['straceObserved'])
                self.assertGreater(report['unparsedRecords'],0)
                if fork_known:self.assertFalse(self.task(report,3)['observed'])

    def test_unavailable_kernel_never_creates_zero_network_evidence_for_strace_task(self):
        _,report=self.parse(['1<app> ???( <unfinished ...>','1<app> <... ??? resumed>) = ?',
                            '1<app> +++ killed by SIGKILL +++'])
        source=report['taskEvidence']['source']
        self.assertFalse(source['networkEventsAvailable'])
        self.assertIsNone(report['taskEvidence']['networkRecordCounts'])
        self.assertEqual(self.task(report)['kernelTaskIndices'],[])
        self.assertGreater(report['unparsedRecords'],0)

    def test_partial_task_records_show_observations_without_cross_check_counts(self):
        capture=self.fixture()
        capture.update(status='failed',complete=False,pidNamespaceVerified=False,udpObjects={'complete':False})
        capture['network']['complete']=False
        _,report=self.parse(['1<app> +++ exited with 0 +++'],capture)
        evidence=report['taskEvidence'];source=evidence['source']
        self.assertEqual(evidence['networkRecordCounts']['P'],0)
        for field in ('networkIssueCount','networkReconciled','ringGlobalIssueCount','objectProofVerified','objectIssueCount'):
            self.assertIsNone(source[field], field)
        task=next(row for row in evidence['tasks'] if row['namespaceTid']==1)
        for field in ('networkIssueCount','existingNetworkCorroboration','ringCounts','ringIssueCount','objectCounts','objectIssueCount'):
            self.assertIsNone(task[field], field)
        self.assertIsNone(self.task(report)['existingRegisterResolutions'])
        self.assertGreater(report['unparsedRecords'],0)

    def test_selected_report_retains_capture_wide_identity_context_without_rescoping_verdict(self):
        capture=self.fixture();capture['network']['tasks'].append(dict(pid=2,tgid=2,kernelPid=102,
            kernelTgid=102,parentKernelPid=101,start=2,end=90,lastOrdinal=0,kernelThread=False,ioWorker=False))
        scoped,whole=self.parse(['1<app> execve("/owned/app", [...], 0x1) = 0',
            '1<app> clone(child_stack=NULL, flags=SIGCHLD) = 2',
            '2<host> execve("/owned/aelix-studio-host", [...], 0x1) = 0',
            '2<host> +++ exited with 0 +++','1<app> +++ exited with 0 +++'],capture,(HOST,))
        self.assertEqual(scoped['taskEvidence']['tasks'],whole['taskEvidence']['tasks'])
        self.assertFalse(self.task(scoped,1)['inReportScope']);self.assertTrue(self.task(scoped,2)['inReportScope'])
        self.assertEqual((scoped['processCount'],whole['processCount']),(1,2))

    def test_replacing_diagnostic_payload_cannot_change_any_existing_report_field(self):
        from uring import network
        lines=['1<app> close(7) = ?','1<app> ???( <unfinished ...>',
               '1<app> <... ??? resumed>) = ?','1<app> +++ exited with 0 +++']
        baseline=self.parse(lines,self.fixture())
        with patch.object(network,'summarize_tasks',return_value={'tasks':[],'forgedEligibility':True}):
            replaced=self.parse(lines,self.fixture())
        for before,after in zip(baseline,replaced):
            self.assertEqual({key:value for key,value in before.items() if key!='taskEvidence'},
                             {key:value for key,value in after.items() if key!='taskEvidence'})

    def test_new_diagnostic_claims_cannot_authorize_a_mixed_loss_recapture(self):
        tests=RecaptureTests();report=tests.kernel_loss()
        report['processes'][0].update(unparsedRecords=1,unparsedRecordKinds={'register_stub':1})
        report['unparsedRecords']+=1
        report['taskEvidence']={'purpose':'forged','source':{'complete':True},'resolved':True,'tasks':[]}
        tests.assert_no_recapture(report)
