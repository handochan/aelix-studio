"""Privileged kernel recorder, paired with an unprivileged stopped strace root."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from uring.probe import event_formats,event_fields,pid_numbers_offset,btf_member_offset,hold_programs,program_statistics
from uring.program import program
from uring.network import requirements as network_requirements, parse as parse_network, HOOKS, SOCKET_HOOKS, SOCKET_ARGUMENTS, FILE_WRITE_HOOKS, symbol_evidence
from uring.entry import select as select_entry, btf_signature
from uring.socketProgram import requirements as object_requirements, parse as parse_object, definitions as object_definitions


def recorder_version(raw):
    """READY printf is drained after all attachments in these reviewed sources."""
    match=re.search(r'\bv(\d+)\.(\d+)\.(\d+)\b',raw)
    value=tuple(map(int,match.groups())) if match else None
    if value not in ((0,17,0),(0,20,2)):
        raise RuntimeError('kernel_recorder_readiness_version_unsupported')
    return value


def samples(raw):
    result=[];current=None
    for line in raw.splitlines():
        if line.startswith('TICK|'):current=[int(line.split('|')[1]),0,0,0,0,0,0,0,0]
        elif line=='TICKEND':
            if current is not None:result.append(current)
            current=None
        elif current is not None:
            match=re.fullmatch(r'@(born_count|dead_count|started_req|completed_req|udp_born|udp_freed|udp_stack_enter|udp_stack_return):\s*(\d+)',line)
            if match:current[{'born_count':1,'dead_count':2,'started_req':3,'completed_req':4,'udp_born':5,'udp_freed':6,'udp_stack_enter':7,'udp_stack_return':8}[match[1]]]=int(match[2])
    return result


def parse(raw,stderr,returncode,namespace_inode):
    events=[];counts={};roots=[];states=samples(raw);ready=done=False;invalid=[];sampling=False
    network=[];tasks=[];workers=[];objects=[];object_schema=0
    for line in raw.splitlines():
        if line=='READY':ready=True;continue
        if line=='DONE':done=True;continue
        if line=='OBJECTS|1':object_schema+=1;continue
        if line.startswith('TICK|'):sampling=True;continue
        if line=='TICKEND':sampling=False;continue
        match=re.fullmatch(r'@(root|create|submit|failed|retire|complete|state|born|dead|network|task|worker)_count:\s*(\d+)',line)
        other=re.fullmatch(r'@(started_req|completed_req|untracked_sqpoll|unmatched_completion|namespace_error|unsupported_abi|pre_mismatch|network_return_id_error|raw_state_overlap|pre_layout_error|socket_layout_error|worker_error|worker_enter|worker_return|udp_alloc_enter|udp_alloc_return|udp_object_error|udp_object_count|udp_born|udp_freed|udp_destruct_enter|udp_destruct_return|udp_stack_enter|udp_stack_return|udp_task_exit_enter|udp_task_exit_return):\s*(\d+)',line)
        if match:
            if not sampling:counts[match[1]]=int(match[2])
            continue
        if other:
            if not sampling:counts[other[1]]=int(other[2])
            continue
        if re.fullmatch(r'\s*(?:lost|dropped)\s+\d+\s+events?\s*',line,re.I):continue
        if not line.strip():continue
        fields=line.split('|')
        try:
            if fields[0]=='ROOT' and len(fields)==6:
                roots.append(dict(time=int(fields[1]),kernelTgid=int(fields[2]),kernelPid=int(fields[3]),
                                  pid=int(fields[4]),level=int(fields[5])))
            elif fields[0] in ('P','N','X','H','V'):
                network.append(parse_network(fields))
            elif fields[0]=='O':objects.append(parse_object(fields))
            elif fields[0]=='OVERLAP' and len(fields)==8:
                invalid.append(dict(reason='kernel_raw_state_overlap',time=int(fields[1]),kernelPid=int(fields[2]),
                    pid=int(fields[3]),previousSyscall=int(fields[4]),nextSyscall=int(fields[5]),
                    networkCall=int(fields[6]),ordinal=int(fields[7])))
            elif fields[0]=='PREMISMATCH' and len(fields)==8:
                invalid.append(dict(reason='kernel_pre_entry_mismatch',time=int(fields[1]),kernelPid=int(fields[2]),
                    pid=int(fields[3]),ordinal=int(fields[4]),preEntryCall=int(fields[5]),
                    executedCall=int(fields[6]),executedSyscall=int(fields[7])))
            elif fields[0]=='T' and len(fields)==10:
                flags=int(fields[8])
                if not 0<=flags<=0xffffffff: raise ValueError('invalid_kernel_task_flag')
                tasks.append(dict(end=int(fields[1]),kernelTgid=int(fields[2]),kernelPid=int(fields[3]),
                                  pid=int(fields[4]),tgid=int(fields[5]),start=int(fields[6]),
                                  parentKernelPid=int(fields[7]),kernelThread=bool(flags&0x00200000),
                                  ioWorker=(flags&0x4010)==0x4010,taskFlags=flags,lastOrdinal=int(fields[9])))
            elif fields[0]=='W' and len(fields)==6:
                workers.append(dict(time=int(fields[1]),kernelPid=int(fields[2]),parentKernelPid=int(fields[3]),
                                    flags=int(fields[4]),start=int(fields[5])))
            elif fields[0]=='STATE' and len(fields)==6:
                states.append(list(map(int,fields[1:])))
            elif fields[0]=='K' and len(fields)==3:
                events.append({'kind':'complete','time':int(fields[1]),'ctx':fields[2]})
            elif fields[0]=='R' and len(fields)==3:
                events.append({'kind':'retire','time':int(fields[1]),'ctx':fields[2]})
            elif (fields[0]=='C' and len(fields)==10) or (fields[0] in ('S','F') and len(fields)==9):
                event=dict(kind={'C':'create','S':'submit','F':'failed'}[fields[0]],time=int(fields[1]),
                    ctx=fields[2],kernelTgid=int(fields[3]),kernelPid=int(fields[4]),pid=int(fields[5]),tgid=int(fields[6]))
                if fields[0]=='C':event.update(fd=int(fields[7]),flags=int(fields[8]),sqpollKernelPid=int(fields[9]) if len(fields)==10 else 0)
                else:
                    if fields[8] not in ('0','1'):raise ValueError('Invalid SQPOLL flag')
                    event.update(opcode=int(fields[7]),sqpoll=fields[8]=='1')
                events.append(event)
            else:invalid.append({'reason':'unknown_record','sample':re.sub(r'0x[0-9a-fA-F]+|\d{5,}','<number>',line)[:160]})
        except ValueError:invalid.append('invalid_record')
    expected={kind:sum(e['kind']==label for e in events)
              for kind,label in [('create','create'),('submit','submit'),('failed','failed'),('retire','retire'),('complete','complete')]}
    output=raw+'\n'+stderr
    lost=sum(int(value) for value in re.findall(r'(?:lost|dropped)\s+(\d+)',output,re.I))
    if not lost and re.search(r'\blost\b|\bdropped\b',output,re.I):lost=1
    if counts.get('socket_layout_error',0):
        invalid.extend([{'reason':'kernel_socket_metadata_invalid','pid':event['pid'],
            'hook':SOCKET_HOOKS[event['value']-1],'family':event['result'],'kernelCall':event['call']}
            for event in network if event['kind']=='H' and 1<=event['value']<=len(SOCKET_HOOKS) and
            event['result']<=0][:16])
    complete=(returncode==0 and ready and done and counts.get('root',0)==1 and len(roots)==1 and not invalid
              and not stderr.strip() and not lost and all(counts.get(k,0)==v for k,v in expected.items())
              and counts.get('state',0)==len(states) and bool(states)
              and counts.get('born',0)==counts.get('dead',0) and counts.get('born',0)>0
              and counts.get('started_req',0)==counts.get('completed_req',0)
              and not counts.get('untracked_sqpoll',0) and not counts.get('unmatched_completion',0)
              and not counts.get('namespace_error',0)
              and not counts.get('unsupported_abi',0)
              and not counts.get('pre_mismatch',0) and not counts.get('network_return_id_error',0)
              and not counts.get('raw_state_overlap',0)
              and not counts.get('pre_layout_error',0)
              and not counts.get('socket_layout_error',0)
              and not counts.get('worker_error',0) and counts.get('worker',0)==len(workers)
              and counts.get('worker_enter',0)==counts.get('worker_return',0)
              and counts.get('worker_return',0)>=len(workers)
              and counts.get('network',0)==len(network) and counts.get('task',0)==len(tasks)
              and len(tasks)==counts.get('dead',0))
    complete=(complete and object_schema==1 and not counts.get('udp_object_error',0)
              and counts.get('udp_object_count',0)==len(objects)
              and counts.get('udp_alloc_enter',0)==counts.get('udp_alloc_return',0)
              and counts.get('udp_born',0)==sum(e['kind']=='B' for e in objects)
              and counts.get('udp_freed',0)==sum(e['kind']=='F' for e in objects)
              and counts.get('udp_destruct_enter',0)==sum(e['kind']=='Q' for e in objects)
              and counts.get('udp_destruct_return',0)==sum(e['kind']=='F' for e in objects)
              and counts.get('udp_destruct_enter',0)==counts.get('udp_destruct_return',0))
    complete=complete and counts.get('udp_stack_enter',0)==counts.get('udp_stack_return',0)
    complete=(complete and counts.get('udp_task_exit_enter',0)==counts.get('dead',0)
              and counts.get('udp_task_exit_return',0)==counts.get('dead',0))
    return dict(schema='aelix.io-uring-kernel-capture/1',status='captured' if complete else 'failed',
        complete=complete,lostEvents=lost,reason='io_uring_kernel_events_lost' if lost else None,
        eventCount=len(events),events=events,
        pidNamespaceVerified=complete,namespaceInode=namespace_inode,root=roots[0] if len(roots)==1 else None,
        kernelCounts=counts,recordErrors=invalid,recorderExitCode=returncode,drained=complete,
        network={'complete':complete,'eventCount':len(network),'events':network,'tasks':tasks,'workers':workers},
        udpObjects={'schema':1,'complete':complete,'eventCount':len(objects),'events':objects},
        captureChecks={'ready':ready,'done':done,'rootCount':len(roots),'sampleCount':len(states),
                       'stderrEmpty':not stderr.strip()},
        diagnostics=[re.sub(r'0x[0-9a-fA-F]+','<address>',line)[:240] for line in stderr.splitlines()][:24])


def broker(directory,root_pid,namespace_inode):
    evidence={'status':'failed','complete':False,'lostEvents':0,'events':[],'eventCount':0,'pidNamespaceVerified':False}
    process=None;mounted=False;tracefs=Path('/sys/kernel/tracing');metadata={};held=[]
    try:
        if os.geteuid()!=0:raise RuntimeError('kernel_recorder_sudo_required')
        if not (tracefs/'events').is_dir():
            tracefs.mkdir(parents=True,exist_ok=True)
            subprocess.run(['mount','-t','tracefs','tracefs',str(tracefs)],check=True,capture_output=True);mounted=True
        submit,formats=event_formats(tracefs)
        formats.update(network_requirements(tracefs))
        available={line.split()[0] for line in (tracefs/'available_filter_functions').read_text().splitlines() if line.strip()}
        pre_entry=select_entry(available)
        object_signatures=object_requirements(available)
        metadata={'kernel':os.uname().release,'preEntryProbe':pre_entry}
        signature=json.dumps(btf_signature(pre_entry['symbol']),sort_keys=True)
        worker_signature=json.dumps(btf_signature('create_io_thread'),sort_keys=True)
        exit_signature=json.dumps(btf_signature('do_task_dead'),sort_keys=True)
        socket_signatures={name:btf_signature(name,first_parameter='ptr:struct:'+kind)
                           for name,kind in SOCKET_ARGUMENTS.items()}
        socket_signatures.update({name:btf_signature(name,first_parameter='ptr:struct:file') for name in FILE_WRITE_HOOKS})
        symbols=symbol_evidence()
        failed=tracefs/'events/io_uring/io_uring_req_failed/format'
        if not failed.is_file() or not {'ctx','opcode'}<=event_fields(failed.read_text()):
            raise RuntimeError('io_uring_failed_request_tracepoint_missing')
        completion=tracefs/'events/io_uring/io_uring_complete/format'
        if not completion.is_file() or not {'ctx','req'}<=event_fields(completion.read_text()):
            raise RuntimeError('io_uring_completion_tracepoint_missing')
        offset=pid_numbers_offset()
        socket_rcu_offset=btf_member_offset('sock','sk_rcu')
        object_specs=object_definitions()
        text=program(root_pid,namespace_inode,offset,submit,pre_entry,socket_rcu_offset,object_specs)
        metadata={'tool':'bpftrace','toolVersion':subprocess.check_output(['bpftrace','--version'],text=True).strip(),
                  'kernel':os.uname().release,'tracepoints':[*formats,'io_uring_req_failed','io_uring_complete'],
                  'formatSha256':{name:hashlib.sha256(value.encode()).hexdigest() for name,value in
                                  dict(formats,io_uring_req_failed=failed.read_text(),io_uring_complete=completion.read_text()).items()},
                  'programSha256':hashlib.sha256(text.encode()).hexdigest(),'pidNumbersOffset':offset,
                  'socketProbes':list(SOCKET_HOOKS),'fileWriteProbes':list(FILE_WRITE_HOOKS),'preEntryProbe':pre_entry,
                  'kernelBtfSha256':hashlib.sha256(Path('/sys/kernel/btf/vmlinux').read_bytes()).hexdigest(),
                  'socketSymbols':symbols,'socketSignatureSha256':{name:hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
                                                                  for name,value in socket_signatures.items()},
                  'udpObjectProbes':list(object_signatures),
                  'udpSocketRcuOffset':socket_rcu_offset,
                  'udpTypedProbeDefinitions':object_specs,
                  'udpObjectSignatureSha256':{name:hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
                                              for name,value in object_signatures.items()},
                  'preEntrySignatureSha256':hashlib.sha256(signature.encode()).hexdigest(),
                  'workerSignatureSha256':hashlib.sha256(worker_signature.encode()).hexdigest()}
        metadata['taskExitProbe']={'symbol':'do_task_dead','signatureSha256':hashlib.sha256(exit_signature.encode()).hexdigest(),
                                   'pairedAnnouncement':'sched_process_exit','identityAt':'sched_process_exit'}
        source=directory/'capture.bt';source.write_text(text)
        with (directory/'events.raw').open('w') as stdout,(directory/'recorder.stderr').open('w') as stderr:
            env=dict(os.environ,BPFTRACE_PERF_RB_PAGES='1024')
            version=recorder_version(metadata['toolVersion'])
            metadata['attachmentReadiness']='reviewed-bpftrace-printf-drained-after-all-attachments'
            map_key='BPFTRACE_MAP_KEYS_MAX' if version<(0,20,0) else 'BPFTRACE_MAX_MAP_KEYS'
            env[map_key]='65536'
            # -k diagnoses failed map updates/output helpers. -kk also labels
            # expected hash-map absence as a failed lookup on bpftrace 0.17.
            # Critical task/namespace reads are checked explicitly in BPF and
            # creation PID/TGID/fd/flags are cross-checked against strace.
            process=subprocess.Popen(['bpftrace','-q','-k','-B','line',str(source)],stdout=stdout,stderr=stderr,env=env)
            deadline=time.monotonic()+30
            while time.monotonic()<deadline:
                if process.poll() is not None:raise RuntimeError('kernel_recorder_attach_failed')
                if 'READY\n' in (directory/'events.raw').read_text():break
                time.sleep(0.02)
            else:raise RuntimeError('kernel_recorder_ready_timeout')
            held=hold_programs(process.pid,len(object_specs))
            (directory/'ready.json').write_text(json.dumps({'ready':True,'rootPid':root_pid,'namespaceInode':namespace_inode})+'\n')
            deadline=time.monotonic()+600
            while not (directory/'stop').exists():
                if process.poll() is not None:raise RuntimeError('kernel_recorder_terminated_early')
                if time.monotonic()>deadline:raise RuntimeError('kernel_recorder_lease_expired')
                time.sleep(0.05)
            # strace waits for user descendants, not necessarily SQPOLL/io-wq
            # kernel tasks. Require fresh, balanced task/request observations
            # before stopping the kernel recorder.
            deadline=time.monotonic()+20;balanced=0;previous=None
            while time.monotonic()<deadline:
                states=samples((directory/'events.raw').read_text())
                if states and states[-1]!=previous:
                    previous=states[-1];values=previous
                    if values[1]>0 and values[1]==values[2] and values[3]==values[4] and values[5]==values[6] and values[7]==values[8]:balanced+=1
                    else:balanced=0
                    if balanced>=2:break
                if process.poll() is not None:raise RuntimeError('kernel_recorder_terminated_before_drain')
                time.sleep(0.05)
            else:
                evidence['drainState']={'bornTasks':previous[1],'deadTasks':previous[2],
                    'startedRequests':previous[3],'completedRequests':previous[4],
                    'bornUdpObjects':previous[5],'freedUdpObjects':previous[6],
                    'destructorEntries':previous[7],'destructorReturns':previous[8]} if previous else None
                raise RuntimeError('kernel_tasks_requests_or_udp_objects_not_drained')
            process.send_signal(signal.SIGINT);process.wait(timeout=30)
        evidence=parse((directory/'events.raw').read_text(),(directory/'recorder.stderr').read_text(),process.returncode,namespace_inode)
        evidence.update(metadata)
        evidence['udpProbeLoss']={'complete':True,'mode':'btf-fentry-fexit','hooks':object_specs,
                                  'programs':program_statistics(held)}
        if (evidence.get('root') or {}).get('pid')!=root_pid:
            evidence.update(status='failed',complete=False,pidNamespaceVerified=False,reason='root_namespace_pid_mismatch')
    except (OSError,RuntimeError,ValueError,subprocess.SubprocessError) as error:
        evidence.update(metadata,status='failed',complete=False,reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__)
        if (directory/'recorder.stderr').exists():
            evidence['diagnostics']=[re.sub(r'0x[0-9a-fA-F]+','<address>',line.replace(str(directory),'<capture>'))[:240]
                                     for line in (directory/'recorder.stderr').read_text().splitlines()][:24]
    finally:
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        for descriptor in held:os.close(descriptor)
        if mounted:
            try:subprocess.run(['umount',str(tracefs)],check=True,capture_output=True)
            except subprocess.SubprocessError:evidence.update(status='failed',complete=False,reason='tracefs_cleanup_failed')
        (directory/'kernel.json').write_text(json.dumps(evidence)+'\n')
    return 0 if evidence['complete'] else 87


class Capture:
    def __init__(self,directory):
        self.directory=directory;self.recorder=None
        self.namespace=os.stat('/proc/self/ns/pid').st_ino
    def start(self,root_pid):
        argv=[sys.executable,'-I','-B',str(Path(__file__).resolve()),'--capture',str(self.directory),
              '--root',str(root_pid),'--namespace',str(self.namespace)]
        if os.geteuid()!=0:argv=['sudo','-n',*argv]
        with (self.directory/'broker.stderr').open('w') as stderr:
            self.recorder=subprocess.Popen(argv,stdout=subprocess.DEVNULL,stderr=stderr)
        deadline=time.monotonic()+40
        while time.monotonic()<deadline:
            if self.recorder.poll() is not None:raise RuntimeError('kernel_tracepoint_unavailable')
            if (self.directory/'ready.json').exists():return
            time.sleep(0.02)
        raise RuntimeError('kernel_tracepoint_ready_timeout')
    def stop(self):
        (self.directory/'stop').touch()
        if self.recorder is not None:self.recorder.wait(timeout=45)
        return json.loads((self.directory/'kernel.json').read_text())


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--capture',type=Path)
    parser.add_argument('--root',type=int);parser.add_argument('--namespace',type=int)
    parser.add_argument('--exec-stop',type=Path);parser.add_argument('command',nargs=argparse.REMAINDER)
    args=parser.parse_args()
    if args.exec_stop:
        args.exec_stop.write_text(json.dumps({'pid':os.getpid()})+'\n')
        os.kill(os.getpid(),signal.SIGSTOP)
        command=args.command[1:] if args.command[:1]==['--'] else args.command
        os.execvpe(command[0],command,os.environ)
    else:raise SystemExit(broker(args.capture.resolve(),args.root,args.namespace))
