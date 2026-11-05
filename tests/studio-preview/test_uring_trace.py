"""Tracepoint preflight requires complete kernel event schemas, never empty success."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
    def test_noop_dup2_keeps_ring_cloexec_before_exec(self):
        capture,calls=self.fixture()
        calls.extend([{'call':'dup2','pid':10,'fd':5,'result':5,'sequence':2,'duplicate':True,'cloexec':False},
                      {'call':'exec','pid':10,'result':0,'sequence':3},
                      {'call':'io_uring_enter','pid':10,'fd':5,'result':1,'sequence':4}])
        checked=ops.reconcile(capture,calls,{10},{10})
        self.assertIn('io_uring_descriptor_unattributed',{issue['reason'] for issue in checked['issuesByPid'][10]})
    def test_unlabelled_unknown_close_still_fails_for_a_tracked_ring_fd(self):
        capture,calls=self.fixture()
        calls.append({'call':'close','pid':10,'fd':5,'result':None,'sequence':2,'genericClose':True})
        checked=ops.reconcile(capture,calls,{10},{10})
        self.assertIn('io_uring_descriptor_result_unknown',{issue['reason'] for issue in checked['issuesByPid'][10]})

    def test_generic_nonring_close_does_not_relax_existing_ring_label_contract(self):
        for generic in (False,True):
            capture,calls=self.fixture()
            calls.append({'call':'close','pid':10,'fd':999,'result':None,'sequence':2,'genericClose':generic})
            checked=ops.reconcile(capture,calls,{10},{10})
            self.assertEqual(bool(checked['issuesByPid'].get(10)),not generic)
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
    RAW += 'T|5|100|100|10|10|1|0|0|1\n@task_count: 1\n'
    RAW += 'OBJECTS|1\n'
    RAW += '@udp_task_exit_enter: 1\n@udp_task_exit_return: 1\n'
    def test_recorder_readiness_requires_a_reviewed_attachment_order(self):
        for version in ('0.17.0','0.20.2'):
            self.assertEqual(capture_module.recorder_version('bpftrace v'+version),tuple(map(int,version.split('.'))))
        for version in ('0.21.0','0.17.1','unknown'):
            with self.assertRaisesRegex(RuntimeError,'readiness_version_unsupported'):
                capture_module.recorder_version('bpftrace v'+version)
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

    def test_network_output_loss_abi_and_task_coverage_fail_closed(self):
        for extra in ('@network_count: 1\n', '@task_count: 2\n', '@unsupported_abi: 1\n',
                      '@worker_enter: 1\n','@worker_return: 1\n','@worker_error: 1\n',
                      '@socket_layout_error: 1\n',
                      '@udp_alloc_enter: 1\n','@udp_destruct_enter: 1\n','@udp_stack_enter: 1\n',
                      '@udp_object_count: 1\n','@udp_object_error: 1\n','@udp_task_exit_enter: 2\n',
                      '@network_return_id_error: 1\n',
                      '@raw_state_overlap: 1\n',
                      'N|2|100|100|10|10|1|1|3|0\n'):
            with self.subTest(extra=extra):
                self.assertFalse(capture_module.parse(self.RAW+extra,'',0,123)['complete'])

    def test_pre_entry_mismatch_keeps_numeric_identity_and_remains_fatal(self):
        result=capture_module.parse(self.RAW+'PREMISMATCH|12|123|10|7|0|5|64\n@pre_mismatch: 1\n','',0,123)
        self.assertFalse(result['complete'])
        self.assertEqual(result['recordErrors'],[dict(reason='kernel_pre_entry_mismatch',time=12,
            kernelPid=123,pid=10,ordinal=7,preEntryCall=0,executedCall=5,executedSyscall=64)])


from uring import network
from uring import entry


class PreEntrySelectionTests(unittest.TestCase):
    CONFIG='CONFIG_X86_64=y\nCONFIG_VMAP_STACK=y\n# CONFIG_KASAN is not set\n# CONFIG_X86_FRED is not set\n'

    def test_x64_stack_formula_uses_running_config_and_rejects_unknown_layouts(self):
        for kasan in (False,True):
            for fred in (False,True):
                text=self.CONFIG
                if kasan:text=text.replace('# CONFIG_KASAN is not set','CONFIG_KASAN=y')
                if fred:text=text.replace('# CONFIG_X86_FRED is not set','CONFIG_X86_FRED=y')
                layout=entry.stack_layout(text,'7.0.0-1017-azure',4096)
                self.assertEqual(layout['threadBytes'],32768 if kasan else 16384)
                self.assertEqual(layout['paddingBytes'],16 if fred else 0)
        for text,release,page in [(self.CONFIG,'7.1.0',4096),(self.CONFIG,'7.0.0',65536),
            (self.CONFIG.replace('CONFIG_VMAP_STACK=y','CONFIG_VMAP_STACK=n'),'7.0.0',4096),
            (self.CONFIG.replace('# CONFIG_X86_FRED is not set\n',''),'7.0.0',4096),
            (self.CONFIG+'CONFIG_X86_64=y\n','7.0.0',4096)]:
            with self.assertRaises(RuntimeError):entry.stack_layout(text,release,page)

    @patch('uring.entry.os.sysconf',return_value=4096,create=True)
    def test_missing_inline_symbol_uses_only_verified_native_x64_ptrace_entry(self,_page):
        self.assertEqual(entry.select({'syscall_trace_enter'},'aarch64')['symbol'],'syscall_trace_enter')
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'config';path.write_text(self.CONFIG)
            chosen=entry.select({'ptrace_notify'},'x86_64','7.0.0',[path])
            self.assertEqual(chosen['threadBytes'],16384)
            self.assertEqual(chosen['symbol'],'ptrace_notify')
            self.assertEqual(len(chosen['configSha256']),64)
        for available,arch in [(set(),'x86_64'),({'ptrace_notify'},'aarch64')]:
            with self.assertRaisesRegex(RuntimeError,'missing'):entry.select(available,arch,configs=[])
        with self.assertRaisesRegex(RuntimeError,'config_missing'):
            entry.select({'ptrace_notify'},'x86_64','7.0.0',[])

    def test_btf_signature_uses_parameter_types_instead_of_formatted_names(self):
        import struct
        for endian in ('<','>'):
            with self.subTest(endian=endian),tempfile.TemporaryDirectory() as directory:
                strings=b'\0int\0unsigned long\0ptrace_notify\0'
                types=b''.join([
                    struct.pack(endian+'IIII',1,1<<24,4,0x01000020),
                    struct.pack(endian+'IIII',5,1<<24,8,64),
                    struct.pack(endian+'IIIIIII',0,(13<<24)|2,1,0,1,0,2),
                    struct.pack(endian+'III',19,(12<<24)|1,3),
                ])
                header=struct.pack(endian+'HBBIIIII',0xeb9f,1,0,24,0,len(types),len(types),len(strings))
                path=Path(directory)/'btf';path.write_bytes(header+types+strings)
                self.assertEqual(entry.btf_signature('ptrace_notify',path),{'parameters':['s32','u64'],'return':'s32'})
                with self.assertRaisesRegex(RuntimeError,'function_missing'):entry.btf_signature('missing',path)
                broken=bytearray(types);struct.pack_into(endian+'I',broken,16+8,4)
                path.write_bytes(header+broken+strings)
                with self.assertRaisesRegex(RuntimeError,'signature_mismatch'):entry.btf_signature('ptrace_notify',path)



class KernelNetworkCorrelationTests(unittest.TestCase):
    def test_known_close_missing_return_has_a_separate_no_network_proof(self):
        checked=network.reconcile(self.fixture(),[(10,'close(3<anon_inode:inotify>) = ?',7)],{},
            {10},None,metadata_allowed={(10,7)})
        self.assertEqual(checked['issues'],[])
        evidence=checked['metadataFields'][0]
        self.assertEqual((evidence['pid'],evidence['kernelPid'],evidence['sequence'],evidence['fd']),(10,110,7,3))
        self.assertEqual((evidence['returnValueKnown'],evidence['fdClosureInferred']),(False,False))
        self.assertEqual((evidence['rangeStart'],evidence['rangeEnd']),(1,100))

    def test_other_fd_metadata_or_partial_close_entries_never_get_metadata_proof(self):
        for line in ['close(?) = ?','close(3 <unfinished ...>','dup(3) = ?',
                     'unshare(CLONE_FILES) = ?','fcntl(3, F_DUPFD, 0) = ?', 'mmap(NULL, 1, 0, 0, 3, 0) = ?']:
            checked=network.reconcile(self.fixture(),[(10,line,7)],{}, {10},None,metadata_allowed={(10,7)})
            self.assertEqual(checked['metadataFields'],[],line)

    def test_missing_kernel_coverage_hidden_network_or_incomplete_task_blocks_close_proof(self):
        import copy
        for fault in ('loss','namespace','task','network','unterminated','duplicate'):
            capture=copy.deepcopy(self.fixture());records=[(10,'close(3) = ?',7)]
            terminal={10}
            if fault=='loss':capture['lostEvents']=1
            if fault=='namespace':capture['pidNamespaceVerified']=False
            if fault=='task':capture['network']['tasks']=[]
            if fault=='network':self.add(capture,self.event('H',value=4,result=2,time=3))
            if fault=='unterminated':terminal=set()
            if fault=='duplicate':records*=2
            checked=network.reconcile(capture,records,{}, {10},None,terminal_pids=terminal,metadata_allowed={(10,7)})
            self.assertEqual(checked['metadataFields'],[],fault)
    def fixture(self):
        return {'complete':True,'lostEvents':0,'pidNamespaceVerified':True,
                'network':{'complete':True,'eventCount':0,'events':[],
                    'tasks':[{'pid':10,'tgid':10,'kernelPid':110,'kernelTgid':110,'start':1,'end':100,'lastOrdinal':10,'kernelThread':False}]} }

    def event(self,kind='N',call=1,ordinal=1,value=3,result=0,time=2):
        return dict(kind=kind,time=time,pid=10,tgid=10,kernelPid=110,kernelTgid=110,
                    call=call,ordinal=ordinal,value=value,result=result)

    def run_policy(self,capture,records=(),holes=None):
        return network.reconcile(capture,records,{10:2} if holes is None else holes,{10},None)

    def add(self,capture,*events):
        for event in events:
            if event['kind']=='N':
                capture['network']['events'].append({**event,'kind':'P','time':event['time']-1})
            capture['network']['events'].append(event)
        capture['network']['eventCount']=len(capture['network']['events'])

    def test_no_executed_network_activity_discharges_terminal_hole_with_full_tid_range(self):
        result=self.run_policy(self.fixture())
        self.assertEqual(result['issues'],[])
        self.assertEqual(result['resolved'][0],{'pid':10,'kernelPid':110,'records':2,
            'rangeStart':1,'rangeEnd':100,'networkEntries':0,'socketEvents':0,
            'preEntryInvocations':0,'notExecutedOrdinals':[],
            'reason':'complete_task_lifetime_no_unmatched_kernel_network_activity'})

    def test_hidden_kernel_network_entry_never_discharges_hole(self):
        capture=self.fixture();self.add(capture,self.event())
        result=self.run_policy(capture)
        self.assertEqual(result['resolved'],[])
        self.assertIn('kernel_network_strace_entry_missing',[item['reason'] for item in result['issues']])

    def test_actual_vfs_regular_or_pipe_write_is_non_network_without_a_strace_record(self):
        for call in (5,6):
            for mode,kind in ((0x8000,'regular'),(0x1000,'pipe')):
                capture=self.fixture();file=self.event('V',call=call,value=1 if call==5 else 2,result=mode,time=3)
                file['file']=123
                self.add(capture,self.event(call=call),file,self.event('X',call=call,result=7,time=4))
                checked=self.run_policy(capture)
                self.assertEqual(checked['issues'],[])
                self.assertEqual(checked['resolved'][0]['records'],2)
                self.assertEqual(checked['nonNetworkWrites'][0]['fileKinds'],[kind])
                self.assertNotIn('file',checked['nonNetworkWrites'][0])

    def test_eventfd_proof_must_bind_every_unknown_mode_file_object(self):
        for callback_file,extra_mode,accepted in ((123,None,True),(456,None,False),(123,0xc000,False)):
            capture=self.fixture()
            base=self.event('V',call=5,value=1,result=0,time=3);base['file']=123
            callback=self.event('V',call=5,value=3,result=0,time=4);callback['file']=callback_file
            events=[self.event(call=5),base,callback,self.event('X',call=5,result=8,time=6)]
            if extra_mode is not None:
                extra=self.event('V',call=5,value=1,result=extra_mode,time=5);extra['file']=789;events.append(extra)
            self.add(capture,*events)
            checked=self.run_policy(capture)
            self.assertEqual(not bool(checked['issues']),accepted)
            if accepted:self.assertEqual(checked['nonNetworkWrites'][0]['fileKinds'],['eventfd'])

    def test_missing_vfs_or_socket_unsupported_mode_or_socket_operation_stays_fatal(self):
        for mode,socket in ((None,False),(0,False),(0xc000,False),(0x2000,False),(0x8000,True)):
            capture=self.fixture();events=[self.event(call=5),self.event('X',call=5,result=7,time=5)]
            if mode is not None:
                item=self.event('V',call=5,value=1,result=mode,time=3);item['file']=123;events.append(item)
            if socket:events.append(self.event('H',call=5,value=1,result=2,time=4))
            self.add(capture,*events)
            checked=self.run_policy(capture)
            self.assertTrue(checked['issues']);self.assertEqual(checked['resolved'],[])

    def test_known_call_missing_result_needs_actual_exit_or_terminal_nonexecution(self):
        for executed in (False,True):
            capture=self.fixture();capture['network']['tasks'][0]['lastOrdinal']=1
            events=([self.event(),self.event('X',result=-9,time=4)] if executed else [self.event('P')])
            self.add(capture,*events)
            checked=self.run_policy(capture,[(10,'connect(3, {}) = ?',9)],holes={})
            self.assertEqual(checked['issues'],[])
            self.assertEqual(len(checked['resultFields']),1)
            self.assertEqual(checked['resultFields'][0]['sequence'],9)
            if not executed:
                capture['network']['tasks'][0]['lastOrdinal']=2
                self.assertTrue(self.run_policy(capture,[(10,'connect(3, {}) = ?',9)])['issues'])

    def test_incomplete_write_can_use_actual_vfs_proof_but_not_socket_or_missing_observation(self):
        for mode in (None,0xc000,0x8000):
            capture=self.fixture();self.add(capture,self.event(call=5))
            if mode is not None:
                event=self.event('V',call=5,value=1,result=mode,time=3);event['file']=123
                self.add(capture,event)
            checked=self.run_policy(capture,[(10,'write(3, ',9)],holes={})
            self.assertEqual(not bool(checked['issues']),mode==0x8000)
            self.assertEqual(len(checked['resultFields']),int(mode==0x8000))

    def test_missing_result_never_excuses_unknown_peer_or_unmatched_network_action(self):
        capture=self.fixture();self.add(capture,self.event(),self.event('H',value=4,result=2,time=3),
                                          self.event('X',time=4))
        checked=network.reconcile(capture,[(10,'connect(3, {}) = ?',9)],{10:2},{10},None,
                                  known_destinations=set())
        self.assertEqual(checked['resultFields'],[])
        self.assertTrue(checked['issues'])

    def test_successful_decoded_call_corroborates_all_socket_layers(self):
        capture=self.fixture()
        self.add(capture,self.event(),self.event('H',value=1,result=2,time=3),
                 self.event('H',value=4,result=2,time=4),self.event('X',result=0,time=5))
        result=self.run_policy(capture,[(10,'connect(3, {sa_family=AF_INET}) = 0',1)])
        self.assertEqual(result['issues'],[])
        self.assertEqual(result['resolved'][0]['socketEvents'],2)
        self.assertEqual(result['operationDiagnostics'],[dict(pid=10,sequence=1,fd=3,
            kernelPid=110,kernelTgid=110,tgid=10,ordinal=1,call=1,entryTime=2,returnTime=5,
            socketHooks=['kernel_connect','tcp_v4_connect'],socketFamilies=[2],fileModes=[],reconciled=True)])

    def test_seccomp_emulated_success_cannot_substitute_for_hidden_executed_call(self):
        capture=self.fixture()
        self.add(capture,self.event('P',ordinal=1,time=2),self.event(ordinal=2,time=4),
                 self.event('X',ordinal=2,result=0,time=5))
        result=self.run_policy(capture,[(10,'connect(3, {sa_family=AF_INET}) = 0',1)])
        self.assertTrue(result['issues'])
        self.assertEqual(result['resolved'],[])

    def test_failed_or_emulated_decoded_invocation_has_its_own_pre_entry(self):
        for result in ('0','-1 EPERM (Denied)'):
            capture=self.fixture();self.add(capture,self.event('P'))
            checked=self.run_policy(capture,[(10,'connect(3, {}) = '+result,1)])
            self.assertEqual(checked['issues'],[])
            self.assertEqual(checked['resolved'][0]['preEntryInvocations'],1)

    def test_final_unmatched_pre_entry_can_prove_syscall_not_executed(self):
        capture=self.fixture();capture['network']['tasks'][0]['lastOrdinal']=1
        self.add(capture,self.event('P'))
        result=self.run_policy(capture)
        self.assertEqual(result['issues'],[])
        self.assertEqual(result['resolved'][0]['notExecutedOrdinals'],[1])
        capture['network']['tasks'][0]['lastOrdinal']=2
        self.assertTrue(self.run_policy(capture)['issues'])

    def test_unexecuted_entry_without_a_strace_stub_is_reported_separately(self):
        capture=self.fixture();capture['network']['tasks'][0]['lastOrdinal']=1
        self.add(capture,self.event('P'))
        checked=self.run_policy(capture,holes={})
        self.assertEqual(checked['resolved'],[])
        self.assertEqual(checked['notExecuted'][0]['ordinal'],1)
        self.assertTrue(network.reconcile(capture,[],{},{10},None,terminal_pids=set())['issues'])

    def test_io_workers_need_pre_wakeup_birth_and_real_ring_owner_ancestry(self):
        capture=self.fixture()
        task={'pid':11,'tgid':10,'kernelPid':111,'kernelTgid':110,'start':1,'end':90,
              'lastOrdinal':0,'ioWorker':True,'parentKernelPid':110}
        birth={'kernelPid':111,'parentKernelPid':110,'flags':0x4010,'time':2,'start':1}
        capture['network']['tasks'].append(task)
        capture['network']['workers']=[birth]
        ring={'rings':[{'creatorPid':10,'creatorTgid':10,'submissions':[]}]}
        self.assertEqual(network.reconcile(capture,[],{10:2},{10},ring)['issues'],[])
        for change in ('birth','owner','parent','time','userspace'):
            import copy
            candidate=copy.deepcopy(capture);owned=ring
            if change=='birth':candidate['network']['workers']=[]
            if change=='owner':owned=None
            if change=='parent':candidate['network']['tasks'][1]['parentKernelPid']=999
            if change=='time':candidate['network']['workers'][0]['time']=100
            if change=='userspace':candidate['network']['tasks'][1]['ioWorker']=False
            result=network.reconcile(candidate,[],{10:2},{10},owned)
            self.assertTrue(result['issues']);self.assertEqual(result['resolved'],[])

    def test_missing_pre_entry_return_or_out_of_interval_socket_hook_fails(self):
        for change in ('pre','return','time'):
            capture=self.fixture()
            self.add(capture,self.event(),self.event('X',time=4),self.event('H',value=1,result=2,time=3))
            if change=='pre':capture['network']['events']=[e for e in capture['network']['events'] if e['kind']!='P']
            if change=='return':capture['network']['events']=[e for e in capture['network']['events'] if e['kind']!='X']
            if change=='time':capture['network']['events'][-1]['time']=5
            capture['network']['eventCount']=len(capture['network']['events'])
            result=self.run_policy(capture,[(10,'connect(3, {}) = 0',1)])
            self.assertTrue(result['issues']);self.assertEqual(result['resolved'],[])

    def test_socket_family_zero_is_never_proof_and_ip_destinations_must_parse(self):
        for hook in range(1,len(network.SOCKET_HOOKS)+1):
            capture=self.fixture()
            self.add(capture,self.event(),self.event('X',time=4),
                     self.event('H',value=hook,result=0,time=3))
            self.assertTrue(self.run_policy(capture,[(10,'connect(3, {}) = 0',1)])['issues'])
        capture=self.fixture()
        self.add(capture,self.event(),self.event('X',time=4),self.event('H',value=1,result=2,time=3))
        for peers,failed in ((set(),True),({(10,1)},False)):
            checked=network.reconcile(capture,[(10,'connect(3, {}) = 0',1)],{10:2},{10},None,known_destinations=peers)
            self.assertEqual(bool(checked['issues']),failed)

    def test_socket_write_without_syscall_entry_is_fatal_including_io_uring(self):
        capture=self.fixture();self.add(capture,self.event('H',call=0,ordinal=0,value=7,result=10))
        result=self.run_policy(capture)
        self.assertEqual(result['issues'][0]['reason'],'kernel_socket_operation_strace_missing')
        self.assertEqual(result['resolved'],[])

    def test_lost_incomplete_namespace_or_unattributed_evidence_never_discharges_hole(self):
        for patch in ({'complete':False},{'lostEvents':1},{'pidNamespaceVerified':False}):
            capture=self.fixture();capture.update(patch)
            result=self.run_policy(capture)
            self.assertTrue(result['issues']);self.assertEqual(result['resolved'],[])
        for patch in ({'pid':99},{'kernelPid':999},{'tgid':99},{'time':101}):
            capture=self.fixture();event=self.event();event.update(patch);self.add(capture,event)
            result=self.run_policy(capture)
            self.assertTrue(result['issues']);self.assertEqual(result['resolved'],[])

    def test_fd_return_order_and_duplicate_lifetimes_are_required(self):
        for change in ('fd','result','task','count','tgid'):
            capture=self.fixture();self.add(capture,self.event(),self.event('X',result=0,time=3))
            if change=='task':capture['network']['tasks']*=2
            if change=='count':capture['network']['eventCount']+=1
            expected={10:99 if change=='tgid' else 10}
            result=network.reconcile(capture,[(10,'connect(4, {}) = 0' if change=='fd' else
                'connect(3, {}) = 1' if change=='result' else 'connect(3, {}) = 0',1)],{10:2},{10},None,expected)
            self.assertTrue(result['issues']);self.assertEqual(result['resolved'],[])

    def test_missing_attachment_never_degrades_to_strace_only(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,'missing'):
                network.requirements(Path(directory))
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            path=root/'events/raw_syscalls/sys_enter/format';path.parent.mkdir(parents=True)
            path.write_text('field:long id; field:unsigned long args[6];')
            path=root/'events/raw_syscalls/sys_exit/format';path.parent.mkdir(parents=True)
            path.write_text('field:long id; field:long ret;')
            path=root/'available_filter_functions';path.write_text('\n'.join(network.HOOKS))
            self.assertEqual(len(network.requirements(root)),2)
            enter=root/'events/raw_syscalls/sys_enter/format'
            enter.write_text('field:long id; field:unsigned long args[5];')
            with self.assertRaisesRegex(RuntimeError,'arguments_missing'):network.requirements(root)
            enter.write_text('field:long id; field:unsigned long args[6];')
            for hook in network.HOOKS:
                path.write_text('\n'.join(item for item in network.HOOKS if item!=hook))
                with self.assertRaisesRegex(RuntimeError,'probe_missing'):network.requirements(root)

    def test_alias_evidence_never_publishes_addresses_or_assumes_masked_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'symbols'
            path.write_text('ffffffff82000000 r socket_file_ops\n'
                            'ffffffff81000000 T security_socket_sendmsg\n'
                            'ffffffff81000000 T security_socket_recvmsg\n')
            evidence=network.symbol_evidence(path)
            self.assertEqual(evidence['securityAliasGroups'],[['security_socket_recvmsg','security_socket_sendmsg']])
            self.assertNotIn('ffffffff',str(evidence))
            for contents in ('','0000000000000000 T security_socket_sendmsg\n'):
                path.write_text(contents)
                self.assertFalse(network.symbol_evidence(path)['securityAddressesVisible'])
            path.write_text('ffffffff82000000 T security_socket_sendmsg\nffffffff83000000 T security_socket_sendmsg\n')
            with self.assertRaises(RuntimeError):network.symbol_evidence(path)

    def test_metadata_decoder_rejects_truncated_or_non_numeric_events(self):
        self.assertEqual(network.parse('N|2|110|110|10|10|1|1|3|0'.split('|'))['value'],3)
        self.assertEqual(network.parse('H|2|110|110|10|10|5|1|3|1|64'.split('|'))['nativeSyscall'],64)
        for line in ('N|2|110','H|x|110|110|10|10|0|0|1|2','H|2|110|110|10|10|0|0|1|2'):
            with self.assertRaises(ValueError):network.parse(line.split('|'))


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
