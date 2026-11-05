"""UDP D requires complete kernel-object proof, independent of FD aliases."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import struct
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('object_audit',ROOT/'scripts/studio-preview/fixtures/outboundAudit.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
from uring.socketObjects import reconcile
from uring.socketProgram import parse, requirements, definitions, trampoline_source
from uring.probe import btf_member_offset, program_fdinfo, program_statistics, ProgramLoss
from uring.rawTrace import coverage


class SocketObjectTests(unittest.TestCase):
    def event(self,kind,time,**changes):
        event=dict(kind=kind,time=time,socket=12345,generation=4,kernelPid=101,kernelTgid=101,
                    pid=1,tgid=1,ordinal=1,call=1,fd=3,family=10,
                    hook={'B':0,'C':1,'S':2,'L':7,'U':4,'Q':0,'F':0}[kind],**changes)
        if kind in ('Q','F'):
            event.update({key:0 for key in ('kernelPid','kernelTgid','pid','tgid','ordinal','call','fd')})
        return event

    def fixture(self):
        events=[self.event(kind,time) for kind,time in [('B',5),('C',25),('U',50),('Q',60),('F',65)]]
        tasks=[dict(pid=pid,tgid=pid,kernelPid=kernel,kernelTgid=kernel,start=1,end=100,
                    parentKernelPid=1000,lastOrdinal=9) for pid,kernel in [(1,101),(2,102),(1000,1000)]]
        network_events=[dict(kind=kind,time=time,pid=1,tgid=1,kernelPid=101,kernelTgid=101,call=1,
                             ordinal=1,value=value,result=result)
                        for kind,time,value,result in [('P',10,3,0),('N',20,3,0),('H',24,1,10),('H',25,11,10),('X',30,3,-101)]]
        capture=dict(complete=True,status='captured',lostEvents=0,pidNamespaceVerified=True,namespaceInode=88,
                     eventCount=0,events=[],root={'kernelPid':1000,'time':1},
                     network=dict(complete=True,eventCount=len(network_events),events=network_events,tasks=tasks),
                     udpObjects=dict(schema=1,complete=True,eventCount=len(events),events=events))
        kinds=[kind for kind,label in [(26,'tracing'),(17,'raw'),(7,'interval')] for _ in range(coverage()[label])]
        capture['udpProbeLoss']=dict(complete=True,
            mode='raw-tracepoint-and-btf-fentry-fexit',hooks=definitions(),coverage=coverage(),
            programs=[{'prog_id':index+1,'prog_type':kind,'recursion_misses':0}
                      for index,kind in enumerate(kinds)])
        network=dict(issues=[],operationDiagnostics=[dict(pid=1,tgid=1,kernelPid=101,kernelTgid=101,
            call=1,fd=3,ordinal=1,sequence=3,entryTime=20,returnTime=30)])
        return capture,network

    def check(self,capture=None,network=None,selected=None):
        default_capture,default_network=self.fixture()
        return reconcile(capture or default_capture,network or default_network,{1,2},
                         {1,2} if selected is None else selected,{(1,3)})

    def test_complete_unique_closed_unsent_object_is_D(self):
        result=self.check()
        self.assertEqual((result['verified'],result['exempt'],result['issues']),(True,{(1,3)},[]))
        self.assertNotIn('socket',result['objects'][0])

    def test_pending_close_metadata_requires_the_same_complete_object_release_for_D(self):
        for final_free in (True,False):
            capture,_=self.fixture()
            capture['network']['tasks']=[task for task in capture['network']['tasks'] if task['pid']!=2]
            if not final_free:
                capture['udpObjects']['events'].pop();capture['udpObjects']['eventCount']-=1
            lines=['1<app> execve("/owned/app", [...], 0x1) = 0',
                '1<app> socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP) = 3<UDPv6:[123]>',
                '1<app> connect(3<UDPv6:[123]>, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = -1 ENETUNREACH',
                '1<app> close(3<UDPv6:[123]> <unfinished ...>', '1<app> +++ exited with 0 +++']
            with self.subTest(final_free=final_free),tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'trace';path.write_text('\n'.join(lines)+'\n')
                report=audit.analyze_processes([path],require_lifecycle=True,kernel_capture=capture)[0]
                self.assertEqual(report['udpConnectOnly'],int(final_free))
                self.assertEqual(report['kernelMetadataResolvedRecords'],int(final_free))
                if final_free:
                    self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['classificationErrors']),(0,0,0))
                    self.assertFalse(report['kernelMetadataResolutions'][0]['fdClosureInferred'])
                else:self.assertGreater(report['classificationErrors'],0)

    def test_any_protocol_or_output_send_prevents_D_even_after_alias_import(self):
        for kind,hook in [('S',2),('S',3),('L',7),('L',8),('L',9),('L',10)]:
            capture,network=self.fixture();events=capture['udpObjects']['events']
            events.insert(2,{**self.event(kind,40),'pid':2,'tgid':2,'kernelPid':102,'kernelTgid':102,'hook':hook})
            capture['udpObjects']['eventCount']=len(events)
            result=self.check(capture,network)
            self.assertTrue(result['verified']);self.assertFalse(result['exempt'])

    def test_only_final_destructor_return_proves_release(self):
        for retained in [('B','C','U'),('B','C','U','Q')]:
            capture,network=self.fixture();channel=capture['udpObjects']
            channel['events']=[event for event in channel['events'] if event['kind'] in retained]
            channel['eventCount']=len(channel['events'])
            result=self.check(capture,network)
            self.assertFalse(result['exempt'])
            self.assertIn('udp_socket_release_unobserved',{item['reason'] for item in result['issues']})

    def test_preexisting_object_is_not_D(self):
        capture,network=self.fixture();channel=capture['udpObjects']
        channel['events']=[dict(event,generation=0) for event in channel['events'] if event['kind']!='B']
        channel['eventCount']=len(channel['events'])
        result=self.check(capture,network)
        self.assertFalse(result['exempt']);self.assertFalse(result['verified'])

    def test_same_address_gets_a_new_generation_before_old_destructor_returns(self):
        capture,network=self.fixture();channel=capture['udpObjects']
        channel['events'] += [{**self.event('B',63),'generation':62},
                              {**self.event('Q',70),'generation':62},{**self.event('F',75),'generation':62}]
        channel['eventCount']=len(channel['events'])
        self.assertEqual(self.check(capture,network)['exempt'],{(1,3)})
        channel['events'][-3]['time']=59
        self.assertFalse(self.check(capture,network)['verified'])

    def test_duplicate_connects_or_wrong_invocation_range_never_match(self):
        for modification in ('duplicate','tid','ordinal','range','fd'):
            capture,network=self.fixture();channel=capture['udpObjects'];event=channel['events'][1]
            if modification=='duplicate':channel['events'].insert(2,dict(event,time=26))
            elif modification=='tid':event['kernelPid']=102
            elif modification=='ordinal':event['ordinal']=2
            elif modification=='range':event['time']=31
            else:event['fd']=4
            channel['eventCount']=len(channel['events'])
            self.assertFalse(self.check(capture,network)['exempt'],modification)

    def test_legacy_udp_connect_cannot_be_replaced_by_an_empty_object_channel(self):
        capture,network=self.fixture();capture['udpObjects'].update(events=[],eventCount=0)
        result=reconcile(capture,network,{1,2},{1,2},{(1,3)},required_udp={(1,3)})
        self.assertFalse(result['verified'])
        self.assertEqual(result['issues'],[{'reason':'udp_socket_connect_evidence_missing','pid':1}])

    def test_unmatched_kernel_network_activity_never_authorizes_D(self):
        capture,network=self.fixture();network['issues']=[{'reason':'kernel_network_strace_entry_missing','pid':1}]
        self.assertFalse(self.check(capture,network)['exempt'])

    def test_loss_namespace_missing_hook_or_unattributed_actor_is_fatal(self):
        for modification in ('loss','namespace','count','complete','actor'):
            capture,network=self.fixture()
            if modification=='loss':capture['lostEvents']=1
            elif modification=='namespace':capture['pidNamespaceVerified']=False
            elif modification=='count':capture['udpObjects']['eventCount']+=1
            elif modification=='complete':capture['udpObjects']['complete']=False
            else:capture['udpObjects']['events'][2]['kernelPid']=999
            self.assertFalse(self.check(capture,network)['verified'],modification)
        with self.assertRaisesRegex(RuntimeError,'probe_missing'):requirements(set())

    def test_missing_or_lost_typed_program_evidence_is_never_D(self):
        for modification in ('receipt','hook','count','missing_stat','lost','type','duplicate'):
            capture,network=self.fixture();loss=capture['udpProbeLoss']
            if modification=='receipt':capture.pop('udpProbeLoss')
            elif modification=='hook':loss['hooks'].pop('udp_sendmsg_e')
            elif modification=='count':loss['programs'].pop()
            elif modification=='missing_stat':loss['programs'][0].pop('recursion_misses')
            elif modification=='lost':loss['programs'][0]['recursion_misses']=1
            elif modification=='type':loss['programs'][0]['prog_type']=2
            else:loss['programs'][0]['prog_id']=loss['programs'][1]['prog_id']
            self.assertFalse(self.check(capture,network)['exempt'],modification)
            self.assertFalse(self.check(capture,network)['verified'],modification)

    def test_unknown_hook_or_pre_root_generation_is_not_creation_evidence(self):
        for modification in ('hook','pre_root'):
            capture,network=self.fixture()
            if modification=='hook':capture['udpObjects']['events'][1]['hook']=999
            else:capture['root']['time']=5
            self.assertFalse(self.check(capture,network)['verified'])

    def test_import_or_active_use_across_scope_is_fatal(self):
        for kind in ('U','C','S'):
            capture,network=self.fixture();channel=capture['udpObjects']
            channel['events'].insert(2,{**self.event(kind,40),'pid':2,'tgid':2,'kernelPid':102,'kernelTgid':102})
            channel['eventCount']=len(channel['events'])
            result=self.check(capture,network,selected={1})
            self.assertFalse(result['exempt'])
            self.assertIn('udp_socket_cross_scope',{item['reason'] for item in result['issues']})

    def test_event_parser_rejects_unknown_kinds_and_short_records(self):
        self.assertEqual(parse('O|C|25|12345|4|101|101|1|1|1|1|3|10|1'.split('|'))['ordinal'],1)
        for raw in ('O|C|25','O|UNKNOWN|25|12345|4|101|101|1|1|1|1|3|10|1'):
            with self.assertRaises(ValueError):parse(raw.split('|'))

    def test_FIONCLEX_and_child_exec_do_not_infer_a_false_close(self):
        capture,_=self.fixture();capture['network']['tasks']=capture['network']['tasks'][:1]+capture['network']['tasks'][2:]
        # The actual ioctl is absent from the strace filter. The child retains
        # the FD until exit; only the kernel destructor return authorizes D.
        capture['network']['tasks'].append(dict(pid=2,tgid=2,kernelPid=102,kernelTgid=102,
            start=31,end=95,parentKernelPid=101,lastOrdinal=9))
        capture['udpObjects']['events'][2].update(pid=2,tgid=2,kernelPid=102,kernelTgid=102)
        lines=['1<app> execve("/owned/app", [...], 0x1) = 0',
            '1<app> socket(AF_INET6, SOCK_DGRAM|SOCK_CLOEXEC, IPPROTO_UDP) = 3<UDPv6:[123]>',
            '1<app> connect(3<UDPv6:[123]>, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = -1 ENETUNREACH',
            '1<app> fork() = 2','2<child> execve("/owned/child", [...], 0x1) = 0',
            '1<app> close(3<UDPv6:[123]>) = 0','2<child> +++ exited with 0 +++','1<app> +++ exited with 0 +++']
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'trace';path.write_text('\n'.join(lines)+'\n')
            report=audit.analyze_processes([path],require_lifecycle=True,kernel_capture=capture)[0]
            self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['classificationErrors'],report['udpConnectOnly']),(0,0,0,1))
            pending=lines.copy();pending[3]='1<app> fork( <unfinished ...>'
            pending.insert(5,'1<app> <... fork resumed>) = 2')
            path.write_text('\n'.join(pending)+'\n')
            ordered=audit.analyze_processes([path],require_lifecycle=True,kernel_capture=capture)[0]
            self.assertEqual((ordered['externalAttempts'],ordered['unparsedRecords'],ordered['classificationErrors'],ordered['udpConnectOnly']),(0,0,0,1))
            capture['udpObjects']['events'].pop();capture['udpObjects']['eventCount']-=1
            failed=audit.analyze_processes([path],require_lifecycle=True,kernel_capture=capture)[0]
            self.assertEqual(failed['udpConnectOnly'],0)
            self.assertGreater(failed['classificationErrors'],0)

    def test_proven_tcp_is_never_a_udp_requirement_or_a_udp_exemption(self):
        for address,external in [('::1',0),('2001:db8::2',1)]:
            capture,_=self.fixture();tasks=capture['network']['tasks']
            tasks[1].update(tgid=1,kernelTgid=101,start=31,end=95,parentKernelPid=101)
            events=capture['network']['events']
            for kind,time,value,result in [('P',35,5,0),('N',40,5,0),('H',45,5,10),('X',50,5,-111)]:
                events.append(dict(kind=kind,time=time,pid=2,tgid=1,kernelPid=102,kernelTgid=101,
                    call=1,ordinal=1,value=value,result=result))
            capture['network']['eventCount']=len(events)
            lines=['1<app> execve("/owned/app", [...], 0x1) = 0',
                '1<app> socket(AF_INET6, SOCK_DGRAM, IPPROTO_UDP) = 3<UDPv6:[123]>',
                '1<app> connect(3<UDPv6:[123]>, {sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "2001:db8::1", &sin6_addr)}, 28) = -1 ENETUNREACH',
                '1<app> socket(AF_INET6, SOCK_STREAM, IPPROTO_TCP) = 5<TCPv6:[456]>',
                '1<app> clone(child_stack=NULL, flags=CLONE_FILES|CLONE_THREAD) = 2',
                '1<app> dup(3<UDPv6:[123]> <unfinished ...>',
                f'2<thread> connect(5<TCPv6:[456]>, {{sa_family=AF_INET6, sin6_port=htons(443), inet_pton(AF_INET6, "{address}", &sin6_addr)}}, 28) = -1 ECONNREFUSED',
                '2<thread> close(5<TCPv6:[456]>) = 0',
                '1<app> <... dup resumed>) = 5<UDPv6:[123]>',
                '1<app> close(3<UDPv6:[123]>) = 0','1<app> close(5<UDPv6:[123]>) = 0',
                '2<thread> +++ exited with 0 +++','1<app> +++ exited with 0 +++']
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'trace';path.write_text('\n'.join(lines)+'\n')
                report=audit.analyze_processes([path],require_lifecycle=True,kernel_capture=capture)[0]
                self.assertEqual((report['externalAttempts'],report['unparsedRecords'],report['classificationErrors'],report['udpConnectOnly']),(external,0,0,1))
                self.assertTrue(all(event['syscall']=='connect' and not event['udpAssociationOnly'] for event in report['external']))

class ObjectBtfLayoutTests(unittest.TestCase):
    def test_lost_program_provenance_is_retained_and_still_fatal(self):
        raw=['prog_id:\t12\nprog_type:\t26\nrecursion_misses:\t1\n',
             'prog_id:\t13\nprog_type:\t2\nrecursion_misses:\t2\n']
        with patch('pathlib.Path.read_text',side_effect=raw),patch('uring.probe.program_name',return_value='probe_generated'):
            with self.assertRaises(ProgramLoss) as raised:program_statistics([20,21])
        evidence=raised.exception.evidence
        self.assertEqual(evidence,{'stage':'after-detach','programs':[
            {'prog_id':12,'prog_type':26,'recursion_misses':1,'programName':'probe_generated'},
            {'prog_id':13,'prog_type':2,'recursion_misses':2,'programName':'probe_generated'}]})

    def test_program_statistics_require_one_explicit_zero_recursion_count(self):
        raw='prog_id:\t12\nprog_type:\t26\nrecursion_misses:\t0\n'
        self.assertEqual(program_fdinfo(raw),{'prog_id':12,'prog_type':26,'recursion_misses':0})
        for bad in (raw.replace('misses:\t0','misses:\t1'),raw.replace('recursion_misses:\t0\n',''),
                    raw+'recursion_misses:\t0\n',raw.replace('prog_id:\t12','prog_id:\t0')):
            with self.assertRaises(RuntimeError):program_fdinfo(bad)

    def test_typed_arguments_have_no_unverified_register_fallback(self):
        source='kprobe:udp_sendmsg { $sk=(struct sock*)arg0; }\nkretprobe:sk_alloc { $x=(uint64)retval; }\nkretprobe:__sk_destruct { $pointer=(uint64)arg0; }'
        converted=trampoline_source(source,definitions())
        self.assertIn('kfunc:udp_sendmsg { $sk=(struct sock*)args->sk; }',converted)
        self.assertIn('kretfunc:sk_alloc',converted)
        self.assertIn('kretfunc:__sk_destruct { $pointer=(uint64)args->head; }',converted)
        with self.assertRaisesRegex(RuntimeError,'typed_argument_missing'):
            trampoline_source('kprobe:udp_sendmsg { $x=arg1; }',definitions())

    def test_anonymous_union_and_duplicate_structs_must_agree(self):
        for conflict in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                strings=b'\0sock\0sk_rcu\0'
                # Type1: anonymous union; type2/type3: repeated sock definitions.
                types=struct.pack('<IIIIII',0,(5<<24)|1,16,6,0,0)
                for offset in (64,128 if conflict else 64):
                    types+=struct.pack('<IIIIII',1,(4<<24)|1,64,0,1,offset)
                header=struct.pack('<HBBIIIII',0xeb9f,1,0,24,0,len(types),len(types),len(strings))
                path=Path(directory)/'btf';path.write_bytes(header+types+strings)
                if conflict:
                    with self.assertRaises(RuntimeError):btf_member_offset('sock','sk_rcu',path)
                else:self.assertEqual(btf_member_offset('sock','sk_rcu',path),8)
