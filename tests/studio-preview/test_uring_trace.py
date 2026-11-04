"""Tracepoint preflight requires complete kernel event schemas, never empty success."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
SOURCE=ROOT/'scripts/studio-preview/fixtures/uring/probe.py'
spec=importlib.util.spec_from_file_location('uring_trace_probe',SOURCE)
trace=importlib.util.module_from_spec(spec)
spec.loader.exec_module(trace)


class TracepointFormatTests(unittest.TestCase):
    def make(self,root,submit='io_uring_submit_req'):
        for name,fields in [('io_uring_create',trace.CREATE_FIELDS),(submit,trace.SUBMIT_FIELDS)]:
            path=root/'events/io_uring'/name/'format';path.parent.mkdir(parents=True)
            path.write_text('\n'.join('field:unsigned long '+field+'; offset:0; size:8;' for field in fields))
        return root/'events/io_uring'/submit/'format'

    def test_new_and_old_submission_names_are_supported(self):
        for event in ('io_uring_submit_req','io_uring_submit_sqe'):
            with self.subTest(event=event),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.make(root,event)
                name,formats=trace.event_formats(root)
                self.assertEqual(name,event)
                self.assertEqual(len(formats),2)

    def test_absent_events_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'missing'):
                trace.event_formats(Path(directory))

    def test_incomplete_opcode_or_sq_thread_schema_fails_closed(self):
        for field in ('opcode','sq_thread'):
            with self.subTest(field=field),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);path=self.make(root)
                path.write_text(path.read_text().replace(field,'unavailable'))
                with self.assertRaisesRegex(RuntimeError,'fields_missing'):
                    trace.event_formats(root)

    def test_create_requires_correlatable_ctx_and_fd(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.make(root)
            path=root/'events/io_uring/io_uring_create/format'
            path.write_text(path.read_text().replace('ctx','unavailable'))
            with self.assertRaisesRegex(RuntimeError,'fields_missing'):
                trace.event_formats(root)


class KernelBtfLayoutTests(unittest.TestCase):
    def test_running_kernel_layout_is_read_in_either_byte_order(self):
        import struct
        for endian in ('<','>'):
            with self.subTest(endian=endian),tempfile.TemporaryDirectory() as directory:
                strings=b'\0pid\0numbers\0'
                types=struct.pack(endian+'IIIIII',1,(4<<24)|1,64,5,0,128)
                header=struct.pack(endian+'HBBIIIII',0xeb9f,1,0,24,0,len(types),len(types),len(strings))
                path=Path(directory)/'btf';path.write_bytes(header+types+strings)
                self.assertEqual(trace.pid_numbers_offset(path),16)

    def test_missing_truncated_or_wrong_btf_never_invents_an_offset(self):
        for raw in (b'',b'not-btf'*8,b'\x9f\xeb'+b'\0'*22):
            with self.subTest(raw=raw),tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'btf';path.write_bytes(raw)
                with self.assertRaises(RuntimeError):trace.pid_numbers_offset(path)


spec_ops=importlib.util.spec_from_file_location('uring_ops',SOURCE.with_name('policy.py'))
ops=importlib.util.module_from_spec(spec_ops);spec_ops.loader.exec_module(ops)

class OperationPolicyTests(unittest.TestCase):
    def fixture(self,opcode=29,pid=10,sqpoll=False,issuer=None):
        events=[{'kind':'create','time':1,'ctx':'opaque','pid':pid,'tgid':pid,'fd':5,'flags':2 if sqpoll else 0,'sqpollKernelPid':issuer if sqpoll else 0},
                {'kind':'submit','time':2,'ctx':'opaque','pid':issuer or pid,'tgid':pid,'opcode':opcode,'sqpoll':sqpoll,
                 'kernelPid':issuer or pid,'kernelTgid':pid}]
        capture={'status':'captured','complete':True,'lostEvents':0,'pidNamespaceVerified':True,
                 'eventCount':2,'events':events}
        calls=[{'call':'io_uring_setup','pid':pid,'tgid':pid,'result':5,'flags':2 if sqpoll else 0}]
        return capture,calls

    def test_only_explicit_libuv_file_and_epoll_operations_are_allowed(self):
        for opcode in ops.ALLOWED_OPCODES:
            with self.subTest(opcode=opcode):
                c,s=self.fixture(opcode);r=ops.reconcile(c,s,{10},{10})
                self.assertEqual(r['globalIssues'],[]);self.assertEqual(r['issuesByPid'],{})

    def test_network_unknown_and_unlisted_operations_fail(self):
        for opcode in [*ops.NETWORK_OPCODES,0,22,23,255]:
            with self.subTest(opcode=opcode):
                c,s=self.fixture(opcode);r=ops.reconcile(c,s,{10},{10})
                self.assertTrue(r['issuesByPid'][10])

    def test_sqpoll_uses_context_creator_not_kernel_worker_pid(self):
        c,s=self.fixture(16,sqpoll=True,issuer=999);r=ops.reconcile(c,s,{10},{10})
        self.assertEqual(r['globalIssues'],[])
        self.assertEqual(r['rings'][0]['submissions'][0]['attributedPid'],10)
        self.assertTrue(r['issuesByPid'][10])

    def test_lost_missing_or_incomplete_capture_is_never_zero(self):
        for patch in [{'lostEvents':1},{'status':'failed'},{'complete':False},{'pidNamespaceVerified':False}]:
            with self.subTest(patch=patch):
                c,s=self.fixture();c.update(patch)
                self.assertTrue(ops.reconcile(c,s,{10},{10})['globalIssues'])

    def test_known_outside_ring_keeps_violations_outside_selected_tree(self):
        c,s=self.fixture(16,pid=20);r=ops.reconcile(c,s,{10,20},{10})
        self.assertNotIn(10,r['issuesByPid']);self.assertTrue(r['issuesByPid'][20])
        self.assertEqual(r['selectedOpcodeCounts'],{})

    def test_missing_ring_or_mismatched_strace_fd_fails_closed(self):
        for change in ('missing-create','wrong-fd','missing-strace','wrong-namespace'):
            with self.subTest(change=change):
                c,s=self.fixture()
                if change=='missing-create':c['events']=c['events'][1:];c['eventCount']=1
                if change=='wrong-fd':s[0]['result']=8
                if change=='missing-strace':s=[]
                if change=='wrong-namespace':c['events'][0]['pid']=999
                self.assertTrue(ops.reconcile(c,s,{10},{10})['globalIssues'])


spec_capture=importlib.util.spec_from_file_location('uring_capture',SOURCE.with_name('capture.py'))
capture_module=importlib.util.module_from_spec(spec_capture);spec_capture.loader.exec_module(capture_module)

class KernelCaptureCompletenessTests(unittest.TestCase):
    RAW='READY\nROOT|1|100|100|10|1\nC|2|123|200|201|20|20|5|0|0\nS|3|123|200|201|20|20|29|0\nK|4|123\nSTATE|5|1|1|1|1\nDONE\n@root_count: 1\n@create_count: 1\n@submit_count: 1\n@complete_count: 1\n@state_count: 1\n@born_count: 1\n@dead_count: 1\n@started_req: 1\n@completed_req: 1\n'
    def test_complete_capture_requires_markers_counters_and_no_diagnostic(self):
        self.assertTrue(capture_module.parse(self.RAW,'',0,123)['complete'])
        for raw,stderr,code in [(self.RAW.replace('DONE',''),' ',0),
                                (self.RAW,'Lost 1 events',0),
                                (self.RAW.replace('@submit_count: 1','@submit_count: 2'),'',0),
                                (self.RAW+'unexpected\n','',0),(self.RAW,'',1)]:
            with self.subTest(raw=raw,stderr=stderr,code=code):
                self.assertFalse(capture_module.parse(raw,stderr,code,123)['complete'])

    def test_ring_retirement_is_part_of_capture_integrity(self):
        raw=self.RAW+'R|4|123\n@retire_count: 1\n'
        result=capture_module.parse(raw,'',0,123)
        self.assertTrue(result['complete'])
        self.assertEqual(result['events'][-1]['kind'],'retire')

    def test_lost_events_on_either_output_stream_keep_count_and_failure_reason(self):
        for stdout,stderr in [('Lost 7 events\n',''),('','Lost 7 events\n')]:
            with self.subTest(stdout=stdout,stderr=stderr):
                result=capture_module.parse(self.RAW+stdout,stderr,0,123)
                self.assertFalse(result['complete'])
                self.assertEqual(result['lostEvents'],7)
                self.assertEqual(result['reason'],'io_uring_kernel_events_lost')

    def test_losses_on_both_streams_are_counted_together(self):
        result=capture_module.parse(self.RAW+'Lost 3 events\n','Lost 5 events\n',0,123)
        self.assertEqual(result['lostEvents'],8)
        self.assertFalse(result['complete'])


class RingDescriptorTests(unittest.TestCase):
    fixture=OperationPolicyTests.fixture
    def test_enter_without_a_created_ring_fails_closed(self):
        c,s=self.fixture();s.append({'call':'io_uring_enter','pid':10,'tgid':10,'fd':99,'result':1,'sequence':2})
        self.assertTrue(ops.reconcile(c,s,{10},{10})['issuesByPid'][10])

    def test_positive_submit_count_cannot_exceed_recorded_requests(self):
        c,s=self.fixture();s[0]['sequence']=0
        s.append({'call':'io_uring_enter','pid':10,'tgid':10,'fd':5,'result':3,'sequence':1})
        self.assertTrue(ops.reconcile(c,s,{10},{10})['globalIssues'])

    def test_inherited_foreign_scope_ring_is_not_silently_accepted(self):
        c,s=self.fixture(pid=20);s[0]['sequence']=0
        s.extend([{'call':'fork','pid':20,'tgid':20,'childTgid':10,'shareFiles':False,'sequence':1},
                  {'call':'mmap','pid':10,'tgid':10,'fd':5,'result':0,'sequence':2}])
        self.assertTrue(ops.reconcile(c,s,{10,20},{10})['issuesByPid'][10])

    def test_closed_descriptor_and_registered_index_are_rejected(self):
        for extra in [[{'call':'close','pid':10,'tgid':10,'fd':5,'result':0,'sequence':1}],[]]:
            c,s=self.fixture();s[0]['sequence']=0
            s.extend(extra+[{'call':'io_uring_enter','pid':10,'tgid':10,'fd':5,'result':1,
                             'registeredRing':not bool(extra),'sequence':2}])
            self.assertTrue(ops.reconcile(c,s,{10},{10})['issuesByPid'][10])
