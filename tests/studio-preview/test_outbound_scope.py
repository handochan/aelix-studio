"""Scoped syscall audit: lineage, attribution, fail-closed parsing and real children."""
import importlib.util
import copy
import errno
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
CLONE_CALL = 'clone(child_stack=NULL, flags=SIGCHLD)'
CLONE_RESTART = CLONE_CALL + ' = ? ERESTARTNOINTR (To be restarted)'
CLONE_FAILED = CLONE_CALL + ' = -1 EAGAIN (Resource temporarily unavailable)'


def register_resume(leader):
    """strace 7.3's unreadable-register resume as printed after this leader.

    tabto() pads ') ' to column 40 from the start of the leader; see
    RegisterResumePaddingTests for verbatim strace 7.3 output.
    """
    return leader + '<... ??? resumed>)' + ' ' * (1 + max(0, 40 - (len(leader) + 19))) + '= ?'


def task_capture_fixture():
    return dict(status='captured',complete=True,drained=True,lostEvents=0,pidNamespaceVerified=True,
        namespaceInode=7,eventCount=0,events=[],recordErrors=[],root={'kernelPid':100},
        network={'complete':True,'eventCount':0,'events':[],'workers':[],
            'tasks':[dict(pid=p,tgid=p,kernelPid=k,kernelTgid=k,parentKernelPid=parent,
                          start=1,end=100,lastOrdinal=10,kernelThread=False,ioWorker=False)
                     for p,k,parent in [(100,100,0),(1,101,100)]]})


class CaptureStartupFailureTests(unittest.TestCase):
    def test_failed_start_does_not_read_unparsed_recorder_output(self):
        def factory(directory):
            (directory/'events.raw').write_text('READY\nROOT|1|100|100|123|1\n'
                'P|2|101|101|124|124|1|1|3|0\n'
                'T|5|101|101|124|124|1|100|0|1\nLost 7 events\nUNKNOWN PRIVATE_RECORD\n')
            capture=Mock(namespace=7);capture.start.side_effect=RuntimeError('kernel_tracepoint_unavailable')
            capture.stop.return_value=dict(status='failed',complete=False,pidNamespaceVerified=False,
                lostEvents=0,events=[],eventCount=0)
            return capture
        read_text = Path.read_text

        def reject_raw_read(path, *args, **kwargs):
            self.assertNotIn(path.name, ('events.raw', 'recorder.stderr'))
            return read_text(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            report=Path(directory)/'report.json';process=Mock(pid=123,returncode=0);process.poll.return_value=0
            with patch.dict(os.environ,{},clear=True),patch.object(audit.sys,'platform','linux'), \
                 patch.object(audit,'resolve_strace',return_value='/usr/bin/strace'), \
                 patch.object(audit,'npm_config_paths',return_value=[]), \
                 patch.object(audit,'npm_proxy_configured',return_value=False), \
                 patch.object(audit,'Capture',side_effect=factory), \
                 patch.object(audit,'capture_deadline',return_value=nullcontext()), \
                 patch.object(audit.signal,'setitimer',create=True),patch.object(audit.signal,'ITIMER_REAL',0,create=True), \
                 patch.object(audit.subprocess,'Popen',return_value=process), \
                 patch.object(Path, 'read_text', reject_raw_read):
                code=audit.audit(['/owned/command'],report)
            result=json.loads(report.read_text())
        self.assertEqual(code,87)
        self.assertFalse(result['ioUring']['capture']['complete'])
        self.assertFalse(result['ioUring']['capture']['pidNamespaceVerified'])
        task_evidence = result['taskEvidence']
        self.assertIsNone(task_evidence['source']['lostEvents'])
        self.assertIsNone(task_evidence['tasks'])
        self.assertIsNone(task_evidence['networkRecordCounts'])
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
        def capture(_command, path, *, allow_recapture, **_options):
            code, report = measurements.pop(0)
            path.write_text(json.dumps(report))
            return code, None, allow_recapture and audit.should_recapture(report)
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
            self.assertEqual(audit.capture_once(['/owned/command'],path,capture_timeout=0.02), (87, None, False))
            self.assertEqual(json.loads(path.read_text())['outcome'],'capture_timeout')

    def test_failed_collection_analysis_keeps_its_remaining_budget(self):
        capture=Mock();capture.start.side_effect=RuntimeError('kernel_tracepoint_unavailable')
        capture.stop.return_value={'status':'failed','complete':False,'reason':'kernel_tracepoint_unavailable'}
        process=Mock(pid=123,returncode=0);process.poll.return_value=0
        raw_directories, required_writes = [], []
        write_text = Path.write_text

        def make_capture(directory):
            raw_directories.append(directory)
            return capture

        def observe_write(path, text, *args, **kwargs):
            if path.name in ('timeout.json', 'timeout-whole.json'):
                required_writes.append((path.name, any(raw.exists() for raw in raw_directories),
                                        audit.signal.getitimer(audit.signal.ITIMER_REAL)[0]))
            return write_text(path, text, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ,{},clear=True), \
             patch.object(audit.sys,'platform','linux'), patch.object(audit,'resolve_strace',return_value='/bin/true'), \
             patch.object(audit,'npm_config_paths',return_value=[]), patch.object(audit,'npm_proxy_configured',return_value=False), \
             patch.object(audit,'Capture',side_effect=make_capture), patch.object(audit.subprocess,'Popen',return_value=process), \
             patch.object(Path,'write_text',observe_write), \
             patch.object(audit,'analyze_processes',side_effect=lambda *a,**k: time.sleep(1)):
            path=Path(directory)/'timeout.json';whole=path.with_name('timeout-whole.json')
            result=audit.capture_once(['/owned/command'],path,capture_timeout=0.2,whole_report_path=whole)
            self.assertEqual(result, (87, None, False))
            self.assertIsNone(json.loads(path.read_text())['externalAttempts'])
            self.assertEqual(json.loads(path.read_text())['outcome'],'capture_timeout')
        self.assertEqual(len(raw_directories),1)
        self.assertEqual(required_writes, [('timeout.json',False,0), ('timeout-whole.json',False,0)])

    def test_capture_deadline_fails_without_extending_the_bound_for_replay(self):
        with self.assertRaisesRegex(RuntimeError,'capture_timeout'):
            with audit.capture_deadline(0.02): time.sleep(1)


class AuditClock:
    """Drive the audit's monotonic clock and one-shot POSIX timer together."""

    def __init__(self):
        self.now = 0.0
        self.deadline = None

    def monotonic(self):
        return self.now

    def getitimer(self, which):
        assert which == audit.signal.ITIMER_REAL
        remaining = 0.0 if self.deadline is None else self.deadline - self.now
        return max(0.0, remaining), 0.0

    def setitimer(self, which, seconds, interval=0.0):
        assert interval == 0.0
        previous = self.getitimer(which)
        self.deadline = self.now + seconds if seconds else None
        return previous

    def advance(self, seconds):
        self.now += seconds
        if self.deadline is not None and self.now >= self.deadline:
            self.deadline = None
            handler = audit.signal.getsignal(audit.signal.SIGALRM)
            handler(audit.signal.SIGALRM, None)


@unittest.skipUnless(hasattr(audit.signal,'setitimer'),'POSIX capture deadline required')
class TaskEvidenceIsolationTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.report = self.root / 'audit.json'
        self.whole = self.root / 'whole.json'
        self.clock = AuditClock()
        self.enterContext(patch.object(time, 'monotonic', self.clock.monotonic))
        self.enterContext(patch.object(audit.signal, 'getitimer', self.clock.getitimer))
        self.enterContext(patch.object(audit.signal, 'setitimer', self.clock.setitimer))

    def audit_traces(self, traces, *, capture=None, stderr=b'', scoped=False, on_capture=None, on_start=None,
                     evidence_deadline=None, capture_timeout=1, terminal='+++ exited with 0 +++'):
        tracer = self.root / 'strace'
        tracer.touch()
        process = Mock(pid=123, returncode=0)
        process.poll.return_value = 0
        inputs = iter(traces)
        raw_directories = []

        def factory(directory):
            raw_directories.append(directory)
            if on_capture is not None:
                on_capture(directory)
            records = next(inputs)

            def start(_pid):
                (directory / 'stopped.json').touch()
                (directory / 'network.trace').write_text('\n'.join([
                    '1<app> execve("/owned/app", [...], 0x1) = 0',
                    *(f'1<app> {record}' for record in records),
                    f'1<app> {terminal}',
                ]) + '\n')
                (directory / 'command.stderr').write_bytes(stderr)
                if on_start is not None:
                    on_start(directory)

            return Mock(namespace=7, start=start, stop=Mock(return_value=copy.deepcopy(capture or task_capture_fixture())))

        fixture_env = {key:os.environ[key] for key in ('TMPDIR', audit.SUPERVISOR_DEADLINE_ENV) if key in os.environ}
        with patch.dict(os.environ, fixture_env, clear=True), patch.object(audit.sys, 'platform', 'linux'), \
             patch.object(audit, 'resolve_strace', return_value=str(tracer)), \
             patch.object(audit, 'npm_config_paths', return_value=[]), \
             patch.object(audit, 'npm_proxy_configured', return_value=False), \
             patch.object(audit, 'Capture', side_effect=factory), patch.object(audit.os, 'kill'), \
             patch.object(audit, 'process_table', return_value={}), \
             patch.object(audit.subprocess, 'Popen', return_value=process), \
             patch.object(audit.subprocess, 'check_output', return_value='strace test\n'), \
             redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = audit.audit(['/owned/app'], self.report, capture_timeout=capture_timeout,
                               scope_executables=('/owned/app',) if scoped else (),
                               whole_report_path=self.whole if scoped else None,
                               task_evidence_deadline=evidence_deadline)
        self.assertFalse(any(directory.exists() for directory in raw_directories))
        return code, len(raw_directories)

    def read(self, path=None):
        return json.loads((path or self.report).read_text())

    def assert_evidence_absent(self, report, *, status='unavailable'):
        self.assertEqual(report['taskEvidenceStatus'], status)
        self.assertNotIn('taskEvidence', report)

    def test_unresolved_clone_restart_fails_the_audit_without_recapture(self):
        for scoped in (False, True):
            with self.subTest(scoped=scoped):
                self.assertEqual(self.audit_traces([[CLONE_RESTART]], scoped=scoped), (87, 1))
                report = self.read()
                self.assertEqual(report['cloneRestartResults'], 1)
                self.assertIn(dict(reason='unknown_fork_result', pid=1, syscall='clone'),
                              report['classificationIssues'])

    def test_clone_restart_rejects_impossible_signal_exits(self):
        for signal in ('SIGBOGUS', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGCONT',
                       'SIGCHLD', 'SIGURG', 'SIGWINCH', '19', '9', 'SIGIOT', 'SIGRT_0', 'SIGRT_33',
                       'SIGKILL (core dumped)'):
            with self.subTest(signal=signal):
                terminal = f'+++ killed by {signal} +++'
                self.assertEqual(self.audit_traces([[CLONE_RESTART]], terminal=terminal), (87, 1))
                self.assertIn(dict(reason='unknown_fork_result', pid=1, syscall='clone'),
                              self.read()['classificationIssues'])

    def test_clone_retry_accepts_straces_unmapped_numeric_errno(self):
        for number in (41, 4095):
            with self.subTest(number=number):
                self.assertEqual(self.audit_traces([[CLONE_RESTART, f'{CLONE_CALL} = -1 (errno {number})']]), (0, 1))
                self.assertEqual(self.read()['cloneRestartResults'], 1)

    def test_clone_retry_rejects_errno_spellings_the_tracer_cannot_emit(self):
        for error in ('EBOGUS (Bogus error)', 'EWOULDBLOCK (Resource temporarily unavailable)',
                      '(errno 0)', '(errno 011)', '(errno 11)', '(errno 512)', '(errno 513)',
                      '(errno 514)', '(errno 516)', '(errno 4096)', '(errno 4095) = ?'):
            with self.subTest(error=error):
                self.assertEqual(self.audit_traces([[CLONE_RESTART, f'{CLONE_CALL} = -1 {error}']]), (87, 1))
                self.assertIn(dict(reason='unknown_fork_result', pid=1, syscall='clone'),
                              self.read()['classificationIssues'])

    def test_kernel_only_child_still_blocks_after_a_clone_restart(self):
        capture = task_capture_fixture()
        capture['network']['tasks'].append(dict(pid=3, tgid=3, kernelPid=103, kernelTgid=103,
            parentKernelPid=101, start=2, end=90, lastOrdinal=0, kernelThread=False, ioWorker=False))
        self.assertEqual(self.audit_traces([[CLONE_RESTART, CLONE_FAILED]], capture=capture), (87, 1))
        self.assertIn('kernel_userspace_task_strace_missing',
                      {issue['reason'] for issue in self.read()['classificationIssues']})

    def test_replayed_capture_releases_recordings_under_a_ten_mib_capacity(self):
        raw_root = self.root / 'raw'
        raw_root.mkdir()
        capacity = 10 * 1024 * 1024
        recording = b'x' * (6 * 1024 * 1024)
        occupied_before_capture = []
        raw_at_first_report = []
        write_text = Path.write_text

        def record_events(directory):
            occupied = sum(path.stat().st_size for path in raw_root.glob('*/events.raw'))
            occupied_before_capture.append(occupied)
            if occupied + len(recording) > capacity:
                raise OSError(errno.ENOSPC, 'simulated 10 MiB capture filesystem')
            (directory / 'events.raw').write_bytes(recording)

        def observe_report(path, text, *args, **kwargs):
            if len(occupied_before_capture) == 1 and path in (self.report, self.whole):
                raw_at_first_report.append(list(raw_root.iterdir()))
            return write_text(path, text, *args, **kwargs)

        with patch.object(tempfile, 'tempdir', str(raw_root)), patch.object(Path, 'write_text', observe_report):
            self.assertEqual(self.audit_traces([['??? PORTABLE_UNKNOWN'], []], scoped=True, on_start=record_events), (0, 2))
        self.assertEqual(occupied_before_capture, [0, 0])
        self.assertTrue(raw_at_first_report)
        self.assertFalse(any(raw_at_first_report))
        self.assertEqual([entry['exitCode'] for entry in self.read()['captureAttempts']], [87, 0])
        self.assertEqual(self.read()['taskEvidenceStatus'], 'available')
        for name in ('audit', 'whole'):
            first = self.read(self.root / f'{name}.capture-1.json')
            self.assert_evidence_absent(first, status='discarded-before-recapture')

    def test_required_writes_and_replay_follow_base_disk_and_timer_checkpoints(self):
        publish = audit.write_task_evidence
        write_text, write_bytes, read_text = Path.write_text, Path.write_bytes, Path.read_text
        raw_root = self.root / 'raw'
        raw_root.mkdir()

        def capture_checkpoints(number):
            # The base uses the capture alarm for the verdict pair, followed
            # by the snapshots and durable attempt history outside that alarm.
            return [('capture-start', True), ('whole.json', True), ('audit.json', True),
                    (f'audit.capture-{number}.json', False), (f'whole.capture-{number}.json', False),
                    ('audit.json', False)]

        for traces, expected, codes in (
            ([[]], capture_checkpoints(1), [0]),
            ([['??? PORTABLE_UNKNOWN'], []], capture_checkpoints(1) + [('audit.json', False)] + capture_checkpoints(2), [87, 0]),
        ):
            with self.subTest(codes=codes):
                checkpoints, trace_reads, publication_checks = [], [], []

                def observe(operation, current_capture=None):
                    active = audit.signal.getitimer(audit.signal.ITIMER_REAL)[0] > 0
                    raw = tuple(sorted(path.name for path in raw_root.iterdir() if path != current_capture))
                    temporary = tuple(sorted(path.name for path in self.root.glob('.task-evidence-*')))
                    checkpoints.append((operation, active, raw, temporary))

                def observe_writer(writer):
                    def write(path, data, *args, **kwargs):
                        if path.parent == self.root and path.suffix == '.json':
                            observe(path.name)
                        return writer(path, data, *args, **kwargs)
                    return write

                def observe_trace_read(path, *args, **kwargs):
                    if path.name == 'network.trace':
                        trace_reads.append(path)
                    return read_text(path, *args, **kwargs)

                def publish_after_required_writes(report, pending, payload):
                    publication_checks.append(len(checkpoints))
                    return publish(report, pending, payload)

                with patch.object(tempfile, 'tempdir', str(raw_root)), \
                     patch.object(Path, 'write_text', observe_writer(write_text)), \
                     patch.object(Path, 'write_bytes', observe_writer(write_bytes)), \
                     patch.object(Path, 'read_text', observe_trace_read), \
                     patch.object(audit, 'write_task_evidence', side_effect=publish_after_required_writes):
                    self.assertEqual(self.audit_traces(traces, scoped=True,
                        on_capture=lambda directory: observe('capture-start', directory)), (0, len(codes)))
                self.assertEqual(checkpoints, [(name, active, (), ()) for name, active in expected])
                result = self.read()
                self.assertEqual([entry['exitCode'] for entry in result['captureAttempts']], codes)
                self.assertEqual(publication_checks, [len(expected)] * 4)
                self.assertEqual(len(trace_reads), len(codes))

    def test_final_verdict_fits_shared_ten_mib_capacity_with_or_without_diagnostic_budget(self):
        capacity = 10 * 1024 * 1024
        write_text = Path.write_text
        raw_root = self.root / 'raw'
        raw_root.mkdir()

        def consume_last_block(directory):
            # Emulate a full mount in the portable regression. The separate
            # tmpfs reproduction exercises the kernel's ENOSPC behavior.
            with (directory / 'events.raw').open('wb') as stream:
                stream.truncate(capacity - 4096)
            (directory / 'kernel.json').write_bytes(b'k' * 4096)

        def write_receipt(path, text, *args, **kwargs):
            if path.parent == self.root and path.suffix == '.json':
                occupied = sum(file.stat().st_size for file in raw_root.glob('*/*') if file.is_file())
                if occupied + len(text.encode()) > capacity:
                    path.touch()
                    raise OSError(errno.ENOSPC, 'simulated shared 10 MiB capture and report mount')
            return write_text(path, text, *args, **kwargs)

        for has_budget in (False, True):
            with self.subTest(has_budget=has_budget), patch.object(tempfile, 'tempdir', str(raw_root)), \
                 patch.object(Path, 'write_text', write_receipt), \
                 patch.object(audit, 'write_task_evidence', wraps=audit.write_task_evidence) as publish:
                deadline = None if has_budget else self.clock.monotonic() + 2
                self.assertEqual(self.audit_traces([[]], scoped=True, on_start=consume_last_block,
                                                   evidence_deadline=deadline), (0, 1))
                self.assertEqual(publish.call_count, 4 if has_budget else 0)
                for path in (self.report, self.whole, self.root/'audit.capture-1.json', self.root/'whole.capture-1.json'):
                    report = self.read(path)
                    self.assertEqual((report['externalAttempts'], report['unparsedRecords']), (0, 0))
                    self.assertEqual(report['taskEvidenceStatus'], 'available' if has_budget else 'unavailable')

    def test_evidence_is_published_after_replay_finishes(self):
        publish = audit.write_task_evidence
        verdicts_during_publication = []

        def publish_after_verdict(report, pending, payload):
            verdicts_during_publication.append([entry['exitCode'] for entry in self.read()['captureAttempts']])
            return publish(report, pending, payload)

        with patch.object(audit, 'write_task_evidence', side_effect=publish_after_verdict):
            self.assertEqual(self.audit_traces([['??? PORTABLE_UNKNOWN'], []]), (0, 2))
        self.assertEqual(verdicts_during_publication, [[87, 0], [87, 0]])
        first = self.read(self.root / 'audit.capture-1.json')
        self.assertEqual(first['outcome'], 'evidence_incomplete')
        self.assert_evidence_absent(first, status='discarded-before-recapture')

    def test_gap_counter_failure_does_not_abort_capture_or_enable_replay(self):
        with patch.object(audit.TaskEvidence, 'gap', side_effect=ValueError('PRIVATE_ERROR')):
            self.assertEqual(self.audit_traces([['??? PORTABLE_UNKNOWN'], []]), (0, 2))
        first = self.read(self.root / 'audit.capture-1.json')
        self.assert_evidence_absent(first)
        self.assertEqual([entry['exitCode'] for entry in self.read()['captureAttempts']], [87, 0])

    def test_aggregate_failure_preserves_pass_denial_and_second_incomplete_capture(self):
        capture = task_capture_fixture()
        capture['network']['events'] = [dict(kind=kind,time=stamp,pid=1,tgid=1,kernelPid=101,kernelTgid=101,
            call=1,ordinal=1,value=3,result=-101 if kind=='X' else 0) for stamp,kind in enumerate('PNX',2)]
        capture['network']['eventCount'] = 3
        cases = [([[]], None, [0], 'passed'),
                 ([[CONNECT]], capture, [86], 'external_attempts'),
                 ([['??? PORTABLE_UNKNOWN']]*2, None, [87, 87], 'evidence_incomplete')]
        for traces, evidence, codes, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(audit.TaskEvidence, 'result', side_effect=ValueError('PRIVATE_ERROR')):
                self.assertEqual(self.audit_traces(traces, capture=evidence), (codes[-1], len(codes)))
                report = self.read()
                self.assertEqual(([row['exitCode'] for row in report['captureAttempts']], report['outcome']), (codes, outcome))
                self.assert_evidence_absent(report)
                self.assertEqual(report['taskEvidenceUnavailableReason'], 'aggregation_error')

    def test_small_record_delays_stop_aggregation_without_expiring_the_one_second_capture(self):
        count = 84
        capture = task_capture_fixture()
        capture['network']['tasks'][1].update(lastOrdinal=count, end=count * 4 + 10)
        events = [dict(pid=1, tgid=1, kernelPid=101, kernelTgid=101, call=5, ordinal=ordinal,
                       time=ordinal * 4 + phase, kind=kind, value=1 if kind == 'V' else 7,
                       result=0x8000 if kind == 'V' else 1, file=7 if kind == 'V' else None)
                  for ordinal in range(1, count + 1) for phase, kind in enumerate('PNVX')]
        capture['network'].update(events=events, eventCount=len(events))
        lines = ['write(7</owned/file>, ""..., 1) = 1'] * count
        paths = (self.report, self.whole, self.root / 'audit.capture-1.json', self.root / 'whole.capture-1.json')

        def verdict(path):
            return {key: value for key, value in self.read(path).items() if not key.startswith('taskEvidence')}

        self.assertEqual(self.audit_traces([lines], capture=capture, scoped=True,
                                           evidence_deadline=self.clock.monotonic() + 2), (0, 1))
        baseline = [verdict(path) for path in paths]
        observe = audit.TaskEvidence.network_record
        calls = 0

        def small_delay(evidence, *args):
            nonlocal calls
            calls += 1
            self.clock.advance(0.004)
            return observe(evidence, *args)

        # The whole phase would spend more than one second in the observer.
        # Phase-boundary checks alone cannot stop it before the capture alarm.
        with patch.object(audit.TaskEvidence, 'network_record', small_delay):
            self.assertEqual(self.audit_traces([lines], capture=capture, scoped=True), (0, 1))
        self.assertEqual([verdict(path) for path in paths], baseline)
        self.assertGreater(calls, 32)
        self.assertLess(calls, len(events))
        for path in paths:
            report = self.read(path)
            self.assert_evidence_absent(report)
            self.assertEqual(report['taskEvidenceUnavailableReason'], 'capture_time_reserve')
            self.assertAlmostEqual(report['taskEvidenceAggregationSeconds'], calls * 0.004, places=6)
            self.assertLess(report['taskEvidenceAggregationSeconds'], 1)

    def test_capture_alarm_is_not_swallowed_by_an_aggregate_observer(self):
        with patch.object(audit.TaskEvidence, 'result', side_effect=audit.CaptureInterrupted('capture_timeout')):
            self.assertEqual(self.audit_traces([[]]), (87, 1))
        self.assertEqual(self.read()['outcome'], 'capture_timeout')
        self.assertIsNone(self.read()['externalAttempts'])
        self.assertEqual(self.read()['taskEvidenceUnavailableReason'], 'capture_interrupted')

    def test_partial_diagnostic_write_leaves_scoped_and_whole_verdicts_readable(self):
        failures = []

        def fail_with_evidence(report, pending, payload):
            failures.append(report)
            pending.write_text('{')
            raise OSError(errno.ENOSPC, 'simulated diagnostic storage failure')

        with patch.object(audit, 'write_task_evidence', fail_with_evidence):
            self.assertEqual(self.audit_traces([[]], scoped=True), (0, 1))
        self.assertTrue(failures)
        self.assertEqual(self.read()['outcome'], 'passed')
        self.assertEqual(self.read(self.whole)['enforcement'], 'report-only')
        for path in (self.report, self.whole, self.root / 'audit.capture-1.json', self.root / 'whole.capture-1.json'):
            self.assert_evidence_absent(self.read(path))
        self.assertEqual(list(self.root.glob('.task-evidence-*')), [])

    def test_publication_preserves_large_saved_verdicts_with_either_line_ending(self):
        verdict = dict(taskEvidenceStatus='unavailable', value='x' * 70000)
        for newline in ('\n', '\r\n'):
            with self.subTest(newline=newline):
                encoded = (json.dumps(verdict, indent=2) + '\n').replace('\n', newline).encode('ascii')
                self.report.write_bytes(encoded)
                audit.write_task_evidence(self.report, self.whole, b'{"tasks":[]}')
                self.assertEqual(self.report.read_bytes(), encoded)
                self.assertEqual(self.read(self.whole), verdict | dict(taskEvidenceStatus='available', taskEvidence={'tasks':[]}))

    def test_final_evidence_write_timeout_preserves_replay_receipts(self):
        writes = []

        def delay_write(report, pending, payload):
            writes.append(report)
            pending.write_text('{')
            self.clock.advance(1.3)

        with patch.object(audit, 'write_task_evidence', delay_write), \
             patch.object(audit, 'TASK_EVIDENCE_WRITE_TIMEOUT', 0.15):
            self.assertEqual(self.audit_traces([['??? PORTABLE_UNKNOWN'], []]), (0, 2))
        self.assertEqual(len(writes), 1)
        first = self.read(self.root / 'audit.capture-1.json')
        self.assertEqual(first['outcome'], 'evidence_incomplete')
        self.assert_evidence_absent(first, status='discarded-before-recapture')
        report = self.read()
        self.assertEqual([entry['exitCode'] for entry in report['captureAttempts']], [87, 0])
        self.assert_evidence_absent(report)

    def test_late_unsupported_personality_is_counted_in_both_reports(self):
        stderr = b'Proper structure decoding for this personality is not supported\n'
        self.assertEqual(self.audit_traces([[]], stderr=stderr, scoped=True), (87, 1))
        for path in (self.report, self.whole):
            report = self.read(path)
            self.assertEqual(report['taskEvidence']['source']['unsupportedStracePersonalities'], 1)
            self.assertIn({'reason':'unsupported_strace_personality'}, report['classificationIssues'])


def supervised_audit_fixture(directory, scenario):
    """Stub the tracer inside a real supervised auditor process."""
    root = Path(directory)
    case = TaskEvidenceIsolationTests()
    case.root, case.report, case.whole = root, root / 'audit.json', root / 'whole.json'
    traces = [[]] if scenario == 'pass' else [['??? PORTABLE_UNKNOWN'], []]

    def remember_capture(directory):
        if audit.SUPERVISOR_DEADLINE_ENV in os.environ:
            raise AssertionError('The supervisor budget reached the traced command')
        with (root / 'captures').open('a') as stream:
            stream.write(directory.name + '\n')

    def slow_write(report, pending, payload):
        pending.write_text('{')
        (root / 'diagnostic-started').touch()
        time.sleep(8)

    with patch.object(audit, 'write_task_evidence', slow_write):
        code, _ = case.audit_traces(traces, scoped=True, on_capture=remember_capture)
    return code


def memory_audit_fixture(directory):
    """The 68.6 MiB single-task trace from the memory-pressure regression."""
    import resource

    root = Path(directory)
    case = TaskEvidenceIsolationTests()
    case.root, case.report, case.whole = root, root / 'audit.json', root / 'whole.json'
    signal_record = (b'1<app> --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=3, '
                     b'si_uid=1000, si_status=0, si_utime=0, si_stime=0} ---\n')
    blocks, tail = divmod(int(68.60 * 1024 * 1024) // len(signal_record), 8000)

    def record(directory):
        with (directory / 'network.trace').open('wb') as stream:
            stream.write(b'1<app> execve("/owned/app", [...], 0x1) = 0\n')
            block = signal_record * 8000
            for _ in range(blocks):
                stream.write(block)
            stream.write(signal_record * tail)
            stream.write(b'1<app> +++ exited with 0 +++\n')

    code, attempts = case.audit_traces([[]], scoped=True, on_start=record, capture_timeout=40)
    print(json.dumps(dict(attempts=attempts, peakRssKiB=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)))
    return code


@unittest.skipUnless(sys.platform == 'linux', 'Linux peak RSS accounting required')
class TaskEvidenceMemoryTests(unittest.TestCase):
    def test_large_single_task_trace_fits_the_340_mib_reproduction(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = 'import runpy,sys; raise SystemExit(runpy.run_path(sys.argv[1])["memory_audit_fixture"](sys.argv[2]))'
            result = subprocess.run([sys.executable, '-I', '-B', '-c', script, str(Path(__file__).resolve()), directory],
                                    env=dict(os.environ, TMPDIR=directory), capture_output=True, text=True, timeout=55)
            self.assertEqual(result.returncode, 0, result.stderr)
            measurement = json.loads(result.stdout)
            self.assertEqual(measurement['attempts'], 1)
            self.assertLess(measurement['peakRssKiB'], 340 * 1024)
            for name in ('audit', 'whole', 'audit.capture-1', 'whole.capture-1'):
                report = json.loads((root / f'{name}.json').read_text())
                self.assertEqual((report['externalAttempts'], report['unparsedRecords']), (0, 0))
                self.assertEqual(report['taskEvidenceStatus'], 'available')
                self.assertEqual(len(report['taskEvidence']['straceTasks']), 1)
            self.assertEqual(list(root.glob('host-outbound-audit-*')), [])


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
    def audit_fixture(self, root, scenario):
        raw = root / 'raw'
        raw.mkdir()
        code = 'import runpy,sys; raise SystemExit(runpy.run_path(sys.argv[1])["supervised_audit_fixture"](*sys.argv[2:]))'
        return [sys.executable, '-I', '-B', '-c', code, str(Path(__file__).resolve()),
                str(root), scenario], {'TMPDIR':str(raw)}

    def assert_capture_receipts(self, root, codes, *, collected_first=False):
        report = json.loads((root / 'audit.json').read_text())
        self.assertEqual([entry['exitCode'] for entry in report['captureAttempts']], codes)
        self.assertEqual(report['recaptures'], len(codes) - 1)
        self.assertEqual(len((root / 'captures').read_text().splitlines()), len(codes))
        expected_files = {f'{name}.json' for name in ('audit', 'whole')}
        expected_files.update(f'{name}.capture-{i}.json' for name in ('audit', 'whole') for i in range(1,len(codes)+1))
        self.assertEqual({path.name for path in root.glob('*.json')}, expected_files)
        for path in root.glob('*.json'):
            status = 'discarded-before-recapture' if collected_first and '.capture-1.' in path.name else 'unavailable'
            self.assertEqual(json.loads(path.read_text())['taskEvidenceStatus'], status, path.name)
        self.assertEqual(list((root / 'raw').iterdir()), [])
        self.assertEqual(list(root.glob('.task-evidence-*')), [])

    def test_two_second_supervisor_preserves_verdict_and_replay_with_slow_diagnostics(self):
        for scenario, codes in [('pass', [0]), ('recapture', [87, 0])]:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                command, env = self.audit_fixture(root, scenario)
                result = audit.run_supervised(command, timeout=2, env=env, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assert_capture_receipts(root, codes)
                self.assertFalse((root / 'diagnostic-started').exists())
                report = json.loads((root / 'audit.json').read_text())
                self.assertEqual(report['taskEvidenceUnavailableReason'], 'supervisor_time_reserve')
                self.assertEqual(report['taskEvidenceAggregationSeconds'], 0)

    def test_supervisor_sigterm_cleans_final_capture_and_partial_diagnostic_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            command, env = self.audit_fixture(root, 'recapture')
            process = subprocess.Popen([sys.executable, '-I', '-B', str(SCRIPT), '--supervise', '60', '--', *command],
                                       env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                while not (root / 'diagnostic-started').exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue((root / 'diagnostic-started').exists())
                self.assertTrue(list(root.glob('.task-evidence-*')))
                self.assertEqual(list((root / 'raw').iterdir()), [])
            finally:
                if process.poll() is None:
                    process.terminate()
                _, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 124, stderr)
            self.assert_capture_receipts(root, [87, 0], collected_first=True)

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
                        lines+=[register_resume('2<host> '), '2<host> '+ending,'1<app> +++ exited with 0 +++']
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

    def test_restarted_clone_from_lsb_release_preserves_the_next_child_edge(self):
        scoped, _ = self.parse(self.base() + [
            '2<lsb_release> clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD <unfinished ...>',
            '2<lsb_release> <... clone resumed>, child_tidptr=0xffff890b8ff0) = ? ERESTARTNOINTR (To be restarted)',
            '2<lsb_release> --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=4} ---',
            '2<lsb_release> clone(child_stack=NULL, flags=CLONE_CHILD_CLEARTID|CLONE_CHILD_SETTID|SIGCHLD, child_tidptr=0xffff890b8ff0) = 3<tr>',
            f'3<tr> {CONNECT}',
            '3<tr> +++ exited with 0 +++',
            '2<lsb_release> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords'], scoped['cloneRestartResults']),
                         (1, 0, 1))
        self.assertEqual(next(p for p in scoped['processes'] if p['pid'] == 3)['parentPid'], 2)

    def test_unknown_clone_return_is_still_blocking(self):
        for suffix in ('?', '? <unavailable>', '? ERESTARTNOINTR (To be restarted) extra',
                       '-1 ERESTARTNOINTR (To be restarted)',
                       '? <unavailable>) = ? ERESTARTNOINTR (To be restarted)',
                       '-1 EAGAIN (Resource temporarily unavailable)) = ? ERESTARTNOINTR (To be restarted)'):
            with self.subTest(suffix=suffix):
                scoped, _ = self.parse(self.base() + [
                    f'2<lsb_release> {CLONE_CALL} = {suffix}',
                    f'2<lsb_release> {CLONE_FAILED}',
                    '2<lsb_release> +++ exited with 0 +++',
                    '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertEqual(scoped['cloneRestartResults'], 0)
                self.assertIn('unknown_fork_result', {issue['reason'] for issue in scoped['classificationIssues']})
                self.assertGreater(scoped['unparsedRecords'], 0)

    def test_repeated_clone_notices_are_counted_before_a_definitive_failure_result(self):
        scoped, _ = self.parse(self.base() + [
            f'2<host> {CLONE_RESTART}',
            '2<host> clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>',
            '1<app> close(4) = 0',
            '2<host> <... clone resumed>) = ? ERESTARTNOINTR (To be restarted)',
            f'2<host> {CLONE_FAILED}',
            '2<host> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertEqual((scoped['unparsedRecords'], scoped['cloneRestartResults']), (0, 2))
        self.assertEqual(scoped['cloneRestartResultsUnit'], 'strace-restart-notices')

    def test_clone_restart_can_end_with_same_task_signaled_before_retry(self):
        for signal in ('SIGTERM', 'SIGKILL', 'SIGSEGV (core dumped)', 'SIGRTMIN', 'SIGRT_1', 'SIGRT_32'):
            with self.subTest(signal=signal):
                scoped, _ = self.parse(self.base() + [
                    f'2<host> {CLONE_RESTART}',
                    '2<host> --- SIGCHLD {si_signo=SIGCHLD, si_code=CLD_EXITED, si_pid=4} ---',
                    f'2<host> +++ killed by {signal} +++',
                    '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertEqual((scoped['unparsedRecords'], scoped['cloneRestartResults']), (0, 1))

    def test_clone_retry_can_return_the_written_parent_tid(self):
        scoped, _ = self.parse(self.base() + [
            '2<host> clone(child_stack=NULL, flags=CLONE_PARENT_SETTID|SIGCHLD, parent_tid=0x1234) = ? ERESTARTNOINTR (To be restarted)',
            '2<host> clone(child_stack=NULL, flags=CLONE_PARENT_SETTID|SIGCHLD, parent_tid=[3<child>]) = 3<child>',
            '3<child> +++ exited with 0 +++',
            '2<host> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertEqual((scoped['unparsedRecords'], scoped['cloneRestartResults']), (0, 1))
        self.assertEqual(next(p for p in scoped['processes'] if p['pid'] == 3)['parentPid'], 2)

    def test_later_records_cannot_hide_an_unproven_retry(self):
        for followup in [
            [f'1<app> {CLONE_FAILED}', '2<host> +++ exited with 0 +++'],
            ['2<host> clone(child_stack=NULL, flags=CLONE_FILES|SIGCHLD) = -1 EAGAIN (Resource temporarily unavailable)',
             '2<host> +++ exited with 0 +++'],
            ['2<host> close(4) = 0', f'2<host> {CLONE_FAILED}', '2<host> +++ exited with 0 +++'],
            [f'2<host> {CLONE_CALL} = 0', '2<host> +++ exited with 0 +++'],
            ['2<host> clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>',
             '2<host> +++ killed by SIGKILL +++'],
            ['2<host> +++ killed by SIGKILL +++', f'2<host> {CLONE_FAILED}'],
            ['2<host> +++ killed by 0 +++'],
        ]:
            with self.subTest(followup=followup):
                scoped, _ = self.parse(self.base() + [f'2<host> {CLONE_RESTART}', *followup,
                    '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertIn(dict(reason='unknown_fork_result', pid=2, syscall='clone'),
                              scoped['classificationIssues'])

    def test_a_changed_parent_tid_pointer_cannot_resolve_a_clone_restart(self):
        clone = 'clone(child_stack=NULL, flags=CLONE_PARENT_SETTID|SIGCHLD, parent_tid=0x1234)'
        scoped, _ = self.parse(self.base() + [
            f'2<host> {clone} = ? ERESTARTNOINTR (To be restarted)',
            f'2<host> {clone.replace("0x1234", "0x5678")} = -1 EAGAIN (Resource temporarily unavailable)',
            '2<host> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertIn(dict(reason='unknown_fork_result', pid=2, syscall='clone'),
                      scoped['classificationIssues'])

    def test_pending_clone_restart_at_end_of_trace_is_unparsed(self):
        scoped, _ = self.parse(self.base() + [f'2<host> {CLONE_RESTART}'])
        self.assertIn(dict(reason='unknown_fork_result', pid=2, syscall='clone'),
                      scoped['classificationIssues'])

    def test_clone_resume_from_another_task_is_rejected(self):
        scoped, _ = self.parse(self.base() + [
            f'2<host> {CLONE_RESTART}',
            '2<host> clone(child_stack=NULL, flags=SIGCHLD <unfinished ...>',
            '1<app> <... clone resumed>) = -1 EAGAIN (Resource temporarily unavailable)',
            '2<host> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertIn(dict(reason='unknown_fork_result', pid=2, syscall='clone'),
                      scoped['classificationIssues'])
        self.assertIn(dict(reason='incomplete_syscall', pid=1, syscall='clone'),
                      scoped['classificationIssues'])

    def test_a_different_syscalls_restart_errno_remains_unparsed(self):
        for call in ('clone3({flags=0}, 88)', 'close(4)'):
            with self.subTest(call=call):
                scoped, _ = self.parse(self.base() + [
                    f'2<host> {call} = ? ERESTARTNOINTR (To be restarted)',
                    f'2<host> {CLONE_FAILED}',
                    '2<host> +++ exited with 0 +++',
                    '1<app> +++ exited with 0 +++'], lifecycle=True)
                self.assertEqual(scoped['cloneRestartResults'], 0)
                self.assertGreater(scoped['unparsedRecords'], 0)

    def test_clone_restart_does_not_account_for_a_missing_child_trace(self):
        scoped, _ = self.parse(self.base() + [
            '2<lsb_release> clone(child_stack=NULL, flags=SIGCHLD) = ? ERESTARTNOINTR (To be restarted)',
            '2<lsb_release> clone(child_stack=NULL, flags=SIGCHLD) = 3<tr>',
            '2<lsb_release> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertEqual(scoped['cloneRestartResults'], 1)
        self.assertIn('missing_child_records', {issue['reason'] for issue in scoped['classificationIssues']})
        self.assertGreater(scoped['unparsedRecords'], 0)

    def test_namespaced_fork_return_uses_tracer_pid_without_colliding(self):
        scoped, _ = self.parse(self.base() + [
            "2<host> clone(child_stack=NULL, flags=CLONE_NEWPID|SIGCHLD) = 2<worker> /* 99 in strace's PID NS */",
            '99<worker> execve("/owned/worker", [...], 0x1 /* 1 var */) = 0',
            f'99<worker> {CONNECT}'])
        self.assertEqual((scoped['externalAttempts'], scoped['unparsedRecords']), (1, 0))
        self.assertEqual(next(p for p in scoped['processes'] if p['pid'] == 99)['parentPid'], 2)

    def test_zero_clone_result_cannot_supply_a_namespaced_child(self):
        scoped, whole = self.parse(self.base() + [
            "2<host> clone(child_stack=NULL, flags=SIGCHLD) = 0 /* 3 in strace's PID NS */",
            '3<child> +++ exited with 0 +++',
            '2<host> +++ exited with 0 +++',
            '1<app> +++ exited with 0 +++'], lifecycle=True)
        self.assertIn(dict(reason='unknown_fork_result', pid=2, syscall='clone'),
                      scoped['classificationIssues'])
        self.assertIsNone(next(p for p in whole['processes'] if p['pid'] == 3)['parentPid'])

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


    @contextmanager
    def check_trace_for_sentinels(self, *sentinels):
        read_text = Path.read_text
        inspected = False
        found = set()

        def inspect(path, *args, **kwargs):
            nonlocal inspected
            text = read_text(path, *args, **kwargs)
            if path.name == 'network.trace':
                found.update(sentinel for sentinel in sentinels if sentinel in text)
                inspected = True
            return text

        with patch.object(Path, 'read_text', inspect):
            yield
        self.assertTrue(inspected, 'The audit must read the captured strace output')
        self.assertEqual(found, set())

    def test_trace_suppresses_argument_and_environment_sentinels(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory)/'report.json'
            with self.check_trace_for_sentinels('SYNTHETIC_ARGUMENT_SECRET', 'SYNTHETIC_ENV_SECRET'), \
                 patch.dict(os.environ, SYNTHETIC_ENV_SECRET='hidden'):
                result = audit.audit(['/bin/true','SYNTHETIC_ARGUMENT_SECRET'], report)
            self.assertEqual(result, 0)


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
            with self.check_trace_for_sentinels('SYNTHETIC_PAYLOAD_SECRET'):
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
            aggregate = audit.TaskEvidence()
            scoped, whole = audit.analyze_processes([path],selected,(),True,capture,task_evidence=aggregate)
            scoped['taskEvidence'] = whole['taskEvidence'] = aggregate.measurement
            return scoped, whole

    def task(self,report,tid=1):
        return next(row for row in report['taskEvidence']['straceTasks'] if row['tid']==tid)

    def test_observed_close_and_register_syntax_survives_existing_resolution_without_contents(self):
        lines=['1<app> execve("/Users/SECRET_TRACE/app", ["SECRET_ARG"], ["SECRET_ENV"]) = 0',
               '1<app> close(7</Users/SECRET_TRACE/file>) = ?',
               '1<app> ???( <unfinished ...>',register_resume('1<app> '),
               '1<app> +++ exited with 0 +++']
        _,report=self.parse(lines,self.fixture());row=self.task(report)
        self.assertEqual((report['unparsedRecords'],report['kernelResolvedRecords'],report['kernelMetadataResolvedRecords']),(0,2,1))
        self.assertEqual((row['existingRegisterResolutions'],row['existingCloseResolutions']),(2,1))
        self.assertEqual(row['terminalSequence'], 5)
        self.assertEqual(row['gapCounts'], {'close-return-unavailable': 1, 'register-entry': 1, 'register-resume': 1})
        self.assertTrue(row['terminalDelimited'] and row['exactStubSyntax'])
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
        self.assertEqual(row['gapCounts'], {'unclassified-record': 1})
        self.assertIn('unknown_record', {issue['reason'] for issue in report['classificationIssues']})
        self.assertNotIn('SECRET',json.dumps(report))

    def test_pending_and_inexact_close_syntax_are_distinct_without_accepting_more(self):
        for text,shape in [('close(7<anon_inode:inotify> <unfinished ...>','close-pending-complete-argument'),
                           ('close(7<incomplete <unfinished ...>','other-result-gap')]:
            with self.subTest(text=text):
                _,report=self.parse(['1<app> '+text,'1<app> +++ exited with 0 +++'],self.fixture())
                self.assertEqual(self.task(report)['gapCounts'], {shape: 1})
                if shape=='other-result-gap':
                    self.assertEqual(report['kernelMetadataResolvedRecords'],0)
                    self.assertGreater(report['unparsedRecords'],0)

    def test_orphan_register_resume_is_not_described_as_a_terminal_delimited_stub(self):
        _,report=self.parse([register_resume('1<app> '),'1<app> +++ exited with 0 +++'],self.fixture())
        self.assertFalse(self.task(report)['terminalDelimited'])
        self.assertGreater(report['unparsedRecords'],0)

    def test_terminal_boundary_does_not_validate_duplicate_resume_or_intervening_syscall(self):
        for invalid in (register_resume('1<app> ')[len('1<app> '):], 'close(7) = 0'):
            with self.subTest(invalid=invalid):
                _,report=self.parse(['1<app> ???( <unfinished ...>', register_resume('1<app> '),
                    f'1<app> {invalid}', '1<app> +++ exited with 0 +++'],self.fixture())
                row=self.task(report)
                self.assertTrue(row['terminalDelimited'])
                self.assertFalse(row['exactStubSyntax'])
                self.assertGreater(report['unparsedRecords'],0)

    def test_many_gaps_for_one_task_add_only_to_fixed_counters(self):
        sizes = []
        for records in (1, 2048):
            _, report = self.parse(['1<app> ??? PRIVATE_CONTENT'] * records + ['1<app> +++ exited with 0 +++'])
            self.assertEqual(self.task(report)['gapCounts'], {'unclassified-record':records})
            encoded = json.dumps(report['taskEvidence'])
            self.assertNotIn('PRIVATE_CONTENT', encoded)
            sizes.append(len(encoded))
        self.assertLess(sizes[1] - sizes[0], 16)

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
                self.assertFalse(any(row['tid']==3 for row in report['taskEvidence']['straceTasks']))

    def test_unavailable_kernel_never_creates_zero_network_evidence_for_strace_task(self):
        _,report=self.parse(['1<app> ???( <unfinished ...>',register_resume('1<app> '),
                            '1<app> +++ killed by SIGKILL +++'])
        source=report['taskEvidence']['source']
        self.assertIsNone(source['networkReconciled'])
        self.assertIsNone(report['taskEvidence']['networkRecordCounts'])
        self.assertIsNone(report['taskEvidence']['tasks'])
        self.assertGreater(report['unparsedRecords'],0)

    def test_incomplete_channel_does_not_invent_task_counts_when_comparison_is_skipped(self):
        capture=self.fixture()
        capture.update(status='failed',complete=False,pidNamespaceVerified=False,udpObjects={'complete':False})
        capture['network']['complete']=False
        _,report=self.parse(['1<app> +++ exited with 0 +++'],capture)
        evidence=report['taskEvidence'];source=evidence['source']
        self.assertIsNone(evidence['networkRecordCounts'])
        self.assertIsNone(evidence['tasks'])
        for field in ('networkIssueCount','networkReconciled','ringGlobalIssueCount','objectProofVerified','objectIssueCount'):
            self.assertIsNone(source[field], field)
        task=self.task(report)
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
        self.assertEqual(scoped['taskEvidence'],whole['taskEvidence'])
        self.assertEqual([row['tid'] for row in scoped['taskEvidence']['straceTasks']], [1, 2])
        self.assertEqual([row['pid'] for row in scoped['processes']], [2])
        self.assertEqual((scoped['processCount'],whole['processCount']),(1,2))

    def test_replacing_diagnostic_payload_cannot_change_any_existing_report_field(self):
        lines=['1<app> close(7) = ?','1<app> ???( <unfinished ...>',
               register_resume('1<app> '),'1<app> +++ exited with 0 +++']
        baseline=self.parse(lines,self.fixture())
        with patch.object(audit.TaskEvidence,'result',return_value={'tasks':[],'forgedEligibility':True}):
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


class RegisterResumePaddingTests(unittest.TestCase):
    """strace 7.3 pads the unreadable-register resume to column 40 (Issue #59)."""

    # Verbatim strace 7.3 output (v7.3 release archive, the audit's options)
    # after leaders of 9, 10, 18, 21 and 23 characters.
    VERBATIM = ('14150<X> <... ??? resumed>)             = ?',
                '14078<AB> <... ??? resumed>)            = ?',
                '14054<Compositor> <... ??? resumed>)    = ?',
                '14111<PerfettoTrace> <... ??? resumed>) = ?',
                '14021<Chrome_ChildIOT> <... ??? resumed>) = ?')
    # Verbatim strace 7.3 output for names it escapes: UTF-8 'Compösitor',
    # 'a<b>c', 'q"\\x', a control byte before '7' (three octal digits) and a tab.
    VERBATIM_ESCAPED = ('14026<Comp\\303\\266sitor> <... ??? resumed>) = ?',
                        '14020<a\\74b\\76c> <... ??? resumed>)     = ?',
                        '14084<q\\"\\\\x> <... ??? resumed>)        = ?',
                        '14057<d\\0017z> <... ??? resumed>)       = ?',
                        '14051<tab\\tname> <... ??? resumed>)     = ?')
    COMPOSITOR = '15423<Compositor> '
    WRITE = 'write(27</dev/null<char 1:3>>, ""..., 1) = 1'
    CONNECT = ('connect(30<UDPv6:[5001]>, {sa_family=AF_INET6, sin6_port=htons(443), sin6_flowinfo=htonl(0), '
               'inet_pton(AF_INET6, "2001:4860:4860::8888", &sin6_addr), sin6_scope_id=0}, 28) '
               '= -1 ENETUNREACH (Network is unreachable)')

    def analyze(self, lines, capture):
        with tempfile.TemporaryDirectory() as directory:
            trace = Path(directory) / 'trace'
            trace.write_text('\n'.join(lines) + '\n')
            return audit.analyze_processes([trace], (), (), True, capture)[1]

    def stub_capture(self, pid):
        capture = task_capture_fixture()
        capture['network']['tasks'][1].update(pid=pid, tgid=pid)
        return capture

    def stub(self, leader, resume, capture=True, ending='+++ exited with 0 +++'):
        pid = int(leader.split('<')[0])
        return self.analyze([leader + '???( <unfinished ...>', resume, leader + ending],
                            self.stub_capture(pid) if capture else None)

    def test_verbatim_strace_resumes_are_exact_register_stubs(self):
        for line in self.VERBATIM + self.VERBATIM_ESCAPED + (register_resume(self.COMPOSITOR),):
            leader = line[:line.index('<... ')]
            with self.subTest(leader=leader):
                self.assertEqual(register_resume(leader), line)
                report = self.stub(leader, line)
                self.assertEqual((report['unparsedRecords'], report['kernelResolvedRecords']), (0, 2))
                # Parsing never discharges the hole without kernel corroboration.
                strict = self.stub(leader, line, capture=False, ending='+++ killed by SIGKILL +++')
                self.assertEqual(strict['classificationIssues'], [])
                self.assertEqual(strict['processes'][0]['unparsedRecordKinds'], {'register_stub': 2})
        # Run 44562904164 kept this record as an unknown 25-character resume.
        self.assertEqual(len(register_resume(self.COMPOSITOR)) - len(self.COMPOSITOR), 25)

    def test_any_other_gap_leader_or_suffix_remains_an_unknown_record(self):
        head = '<... ??? resumed>)'
        lines = {'one space after an 18-character leader': self.COMPOSITOR + head + ' = ?',
                 'three spaces': self.COMPOSITOR + head + '   = ?',
                 'five spaces': self.COMPOSITOR + head + '     = ?',
                 'tab': self.COMPOSITOR + head + '\t= ?',
                 'trailing space': register_resume(self.COMPOSITOR) + ' ',
                 'unavailable suffix': register_resume(self.COMPOSITOR) + ' <unavailable>',
                 'unfinished resume': self.COMPOSITOR + '<... ??? resumed> <unfinished ...>)  = ?',
                 'two-space leader': '15423<Compositor>  ' + head + '   = ?'}
        for name, line in lines.items():
            with self.subTest(name=name):
                report = self.stub(self.COMPOSITOR, line)
                reasons = {issue['reason'] for issue in report['classificationIssues']}
                if name != 'unfinished resume':
                    self.assertIn('unknown_record', reasons)
                self.assertIn('unknown_unfinished_syscall', reasons)
                self.assertGreater(report['unparsedRecords'], 0)
                self.assertEqual(report['kernelResolvedRecords'], 0)
        # Leaders that strace 7.3 printleader() cannot write, each with the
        # padding its length would otherwise get.
        for leader in ('015423<Compositor> ', '007   ', '15423<a<b> ', '15423<q"x> ', '15423<a\\074b> ',
                       '15423<a\\nb> ', '15423<a\\000b> ', '15423<x\\> ', '15423<ABCDEFGHIJKLMNOP> ',
                       '15423<Compösitor> ', '15423<> '):
            with self.subTest(leader=leader):
                report = self.stub(leader, register_resume(leader))
                self.assertIn('unknown_record', {issue['reason'] for issue in report['classificationIssues']})
                self.assertEqual(report['kernelResolvedRecords'], 0)

    def test_leader_without_comm_and_unprefixed_records(self):
        from outboundScope import PREFIX, is_register_resume
        # printleader() uses '%-5u' and one space when comm is not decoded.
        for raw, valid in ((register_resume('7     '), True), (register_resume('7 '), False)):
            prefix = PREFIX.match(raw)
            self.assertEqual(is_register_resume(prefix[3], prefix), valid)
        self.assertFalse(is_register_resume('<... ??? resumed>) = ?', None))

    def ci_replica(self, variant=None):
        """Shapes preserved by run 44562904164's installed-app report."""
        from uring.network import SOCKET_HOOKS
        from uring.rawTrace import coverage
        from uring.socketProgram import definitions
        resume = {'single-space': self.COMPOSITOR + '<... ??? resumed>) = ?',
                  'five-spaces': self.COMPOSITOR + '<... ??? resumed>)     = ?',
                  'tab': self.COMPOSITOR + '<... ??? resumed>)\t= ?',
                  'unavailable-suffix': register_resume(self.COMPOSITOR) + ' <unavailable>'}.get(
                      variant, register_resume(self.COMPOSITOR))
        child = 'clone(child_stack=NULL, flags=SIGCHLD) = '
        lines = ['1<app> execve("/owned/app", [...], 0x1 /* 1 var */) = 0',
                 '1<app> ' + child + '15344<Chrome_ChildIOT>', '1<app> ' + child + '14479<Chrome_ChildIOT>',
                 '1<app> ' + child + '14798<PerfettoTrace>', '1<app> ' + child + '15423<Compositor>',
                 '15344<Chrome_ChildIOT> socket(AF_INET6, SOCK_DGRAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_IP) = 30<UDPv6:[5001]>',
                 '15344<Chrome_ChildIOT> ' + self.CONNECT, '15344<Chrome_ChildIOT> close(30<UDPv6:[5001]>) = 0',
                 '15344<Chrome_ChildIOT> +++ exited with 0 +++', '14479<Chrome_ChildIOT> ' + self.WRITE,
                 self.COMPOSITOR + self.WRITE, self.COMPOSITOR + '???( <unfinished ...>',
                 '14798<PerfettoTrace> ???( <unfinished ...>', resume]
        if variant == 'resume-then-syscall':
            lines.append(self.COMPOSITOR + self.WRITE)
        if variant != 'resume-without-terminal':
            lines.append(self.COMPOSITOR + '+++ exited with 0 +++')
        lines += ['14798<PerfettoTrace> +++ exited with 0 +++', '14479<Chrome_ChildIOT> +++ exited with 0 +++',
                  '1<app> +++ exited with 0 +++']

        def task(pid, kernel, parent, start, end, last):
            return dict(pid=pid, tgid=pid, kernelPid=kernel, kernelTgid=kernel, parentKernelPid=parent,
                        start=start, end=end, lastOrdinal=last, kernelThread=False, ioWorker=False)

        def event(kind, time, pid, call, ordinal, value, result=0, **fields):
            return dict(kind=kind, time=time, pid=pid, tgid=pid, kernelPid=pid + 100000, kernelTgid=pid + 100000,
                        call=call, ordinal=ordinal, value=value, result=result, **fields)

        hook = SOCKET_HOOKS.index('__ip6_datagram_connect') + 1
        tasks = [task(100, 100, 0, 1, 1000, 0), task(1, 101, 100, 2, 999, 10)] + [
            task(pid, pid + 100000, 101, 10, end, last)
            for pid, end, last in ((15344, 35, 3), (14479, 70, 2), (14798, 70, 1), (15423, 70, 2))]
        events = [event('P', 20, 15344, 1, 2, 30), event('N', 21, 15344, 1, 2, 30),
                  event('H', 22, 15344, 1, 2, hook, 10), event('X', 23, 15344, 1, 2, 30, -101),
                  event('P', 40, 14479, 5, 1, 27), event('N', 41, 14479, 5, 1, 27), event('X', 42, 14479, 5, 1, 27, 1),
                  event('P', 60, 14479, 5, 2, 27),  # final pre-entry of a killed task: never executed
                  event('P', 43, 15423, 5, 1, 27), event('N', 44, 15423, 5, 1, 27), event('X', 45, 15423, 5, 1, 27, 1)]
        if variant == 'final-write-executed':
            events += [event('N', 61, 14479, 5, 2, 27), event('X', 62, 14479, 5, 2, 27, 1)]
        if variant == 'final-write-not-last-ordinal':
            tasks[3]['lastOrdinal'] = 3
        if variant == 'hidden-socket-hook-in-stub-task':
            events.append(event('H', 65, 15423, 0, 2, hook, 10))
        socket = dict(socket=0xdead, generation=15, family=10)
        objects = [dict(event('B', 15, 15344, 0, 1, 0), fd=0, hook=0, **socket),
                   dict(event('C', 22, 15344, 1, 2, 0), fd=30, hook=1, **socket)]
        if variant == 'udp-send':
            objects.append(dict(event('S', 25, 15344, 5, 3, 0), fd=30, hook=2, **socket))
        objects += [dict(kind=kind, time=time, pid=0, tgid=0, kernelPid=0, kernelTgid=0, ordinal=0,
                         call=0, fd=0, hook=0, **socket) for kind, time in (('Q', 30), ('F', 31))]
        expected = coverage()
        programs = [dict(prog_id=index + 1, prog_type=kind, recursion_misses=0) for index, kind in enumerate(
            [26] * expected['tracing'] + [17] * expected['raw'] + [7] * expected['interval'])]
        if variant == 'kernel-loss':
            programs[0]['recursion_misses'] = 1
        capture = dict(status='captured', complete=True, drained=True, lostEvents=0, pidNamespaceVerified=True,
                       namespaceInode=7, eventCount=0, events=[], recordErrors=[], root={'kernelPid': 100, 'time': 1},
                       network=dict(complete=True, eventCount=len(events), events=events, workers=[], tasks=tasks),
                       udpObjects=dict(schema=1, complete=True, eventCount=len(objects), events=objects),
                       udpProbeLoss=dict(complete=True, mode='raw-tracepoint-and-btf-fentry-fexit',
                                         hooks=definitions(), coverage=expected, programs=programs))
        return self.analyze(lines, capture)

    def test_run_44562904164_shapes_pass_with_the_exact_resume(self):
        report = self.ci_replica()
        self.assertEqual(report['classificationIssues'], [])
        self.assertEqual((report['unparsedRecords'], report['externalAttempts'], report['udpConnectOnly']), (0, 0, 1))
        # Two Compositor and one PerfettoTrace stub records, by existing kernel proof.
        self.assertEqual((report['kernelResolvedRecords'], report['kernelNotExecutedInvocations']), (3, 1))
        self.assertEqual(report['kernelNotExecuted'][0]['reason'], 'final_pre_entry_without_kernel_execution')

    def test_run_44562904164_negative_controls_still_fail(self):
        expected = {'single-space': 'unknown_record', 'five-spaces': 'unknown_record', 'tab': 'unknown_record',
                    'unavailable-suffix': 'unknown_record', 'resume-then-syscall': 'unknown_unfinished_syscall',
                    'resume-without-terminal': 'missing_terminal_record',
                    'final-write-executed': 'kernel_network_strace_entry_missing',
                    'final-write-not-last-ordinal': 'kernel_network_strace_entry_missing',
                    'hidden-socket-hook-in-stub-task': 'kernel_socket_operation_strace_missing',
                    'udp-send': 'udp_socket_send_strace_unmatched', 'kernel-loss': 'udp_socket_capture_incomplete'}
        for variant, reason in expected.items():
            with self.subTest(variant=variant):
                report = self.ci_replica(variant)
                self.assertIn(reason, {issue['reason'] for issue in report['classificationIssues']})
                self.assertGreater(report['unparsedRecords'], 0)
                self.assertEqual((report['externalAttempts'], report['udpConnectOnly']), (1, 0))

    def test_parsed_stub_with_kernel_loss_still_cannot_recapture(self):
        capture = self.stub_capture(15423)
        capture.update(status='failed', complete=False, reason='kernel_bpf_program_recursion_lost')
        report = self.stub(self.COMPOSITOR, register_resume(self.COMPOSITOR))
        lost = self.analyze([self.COMPOSITOR + '???( <unfinished ...>', register_resume(self.COMPOSITOR),
                             self.COMPOSITOR + '+++ exited with 0 +++'], capture)
        self.assertEqual(report['unparsedRecords'], 0)
        self.assertEqual(lost['processes'][0]['unparsedRecordKinds'], {'register_stub': 2})
        lost.update(outcome='evidence_incomplete', commandStarted=True, commandExitCode=0)
        self.assertFalse(audit.should_recapture(lost))
        # The parsed stub is what blocks it: the same loss alone may recapture once.
        alone = copy.deepcopy(lost)
        alone['processes'][0].update(unparsedRecords=0, unparsedRecordKinds={})
        alone['unparsedRecords'] = len(alone['classificationIssues'])
        self.assertTrue(audit.should_recapture(alone))

    def test_audit_strace_options_keep_the_leader_and_column_this_rule_assumes(self):
        capture = Mock()
        capture.start.side_effect = RuntimeError('kernel_tracepoint_unavailable')
        capture.stop.return_value = dict(status='failed', complete=False, pidNamespaceVerified=False,
                                         lostEvents=0, events=[], eventCount=0)
        process = Mock(pid=123, returncode=0)
        process.poll.return_value = 0
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True), \
             patch.object(audit.sys, 'platform', 'linux'), \
             patch.object(audit, 'resolve_strace', return_value='/pinned/strace'), \
             patch.object(audit, 'npm_config_paths', return_value=[]), \
             patch.object(audit, 'npm_proxy_configured', return_value=False), \
             patch.object(audit, 'Capture', return_value=capture), \
             patch.object(audit, 'capture_deadline', return_value=nullcontext()), \
             patch.object(audit.signal, 'setitimer', create=True), \
             patch.object(audit.signal, 'ITIMER_REAL', 0, create=True), \
             patch.object(audit.subprocess, 'Popen', return_value=process) as popen, \
             redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            audit.audit(['/owned/command'], Path(directory) / 'report.json')
        argv = next(call.args[0] for call in popen.call_args_list if '/pinned/strace' in call.args[0])
        options = argv[argv.index('/pinned/strace') + 1:]
        options = options[:options.index('--')]
        flags = [token for index, token in enumerate(options)
                 if token.startswith('-') and options[index - 1] not in ('-s', '-e', '-o')]
        # -a/--columns, -ff, timestamps, -i, -n or --secontext would change
        # the leader or the alignment column that is_register_resume() assumes.
        self.assertEqual(flags, ['-f', '--decode-pids=comm,pidns', '-yy', '-q', '-s', '-e', '-e', '-o'])
