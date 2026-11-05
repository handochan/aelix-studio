"""Prove that UDP associations closed without any write through any FD alias.

No destination exceptions. Uncertain ownership/lifecycle is fatal. Kernel
tracepoints do not expose the submitted FD: a write submission in a process
that held an association conservatively prevents its exemption (even when
relative syscall/kernel timing cannot prove overlap).
"""
import re

WRITES = {'send', 'sendto', 'sendmsg', 'sendmmsg', 'write', 'writev'}
WRITE_OPCODES = {2, 5, 9, 23, 26, 47, 48, 50, 57, 58, 60}
FD_MUTATING_OPCODES = {19}  # CLOSE may release a UDP descriptor too.


def analyze(records, ring_evidence, tgid, unknown_intervals=()):
    tables = {}; sockets = []; issues = []; writes = []; acquisitions=[]; unknown_closes=[]
    ordered=sorted(records,key=lambda item:item[2])
    task_ends={record[0]:record[2] for record in ordered if record[1].startswith('+++')}
    final_sequence=max((record[2] for record in ordered),default=0)+1
    completed=0; last_sequence=0

    def issue(pid, reason):
        entry = {'pid': pid, 'reason': reason}
        if entry not in issues: issues.append(entry)

    def table(pid):
        return tables.setdefault(pid, {})

    def released(sock):
        sock['lastRelease']=max(sock.get('lastRelease',0),completed)

    def remove(pid, fd):
        entry=table(pid).pop(fd,None)
        if entry:released(entry[0])

    def retire():
        if not sockets:return
        live={sock['id'] for current in tables.values() for sock,_ in current.values()}
        for sock in sockets:
            if sock['id'] not in live and 'lifetimeEnd' not in sock and not sock.get('untrackedAlias'):
                sock['lifetimeEnd']=max(last_sequence,sock.get('lastRelease',0))

    def pending_state(sock, pid):
        if completed > sequence:
            sock['invalid']=True
            for owner in sock['owners']|{pid}:issue(owner,'udp_descriptor_completion_order_unproven')

    for record in ordered:
        retire()
        pid,line,sequence=record[:3]
        completed=record[3] if len(record)>3 else sequence
        last_sequence=sequence
        current=table(pid)
        if line.startswith('+++'):
            # A process must close its associations before its last task exits,
            # including tables shared with another TGID. A surviving thread may
            # retain the same table; losing the last table holder still fails.
            table_survives = any(other is current for task, other in tables.items() if task != pid)
            process_survives = any(tgid(task) == tgid(pid) for task in tables if task != pid)
            if not table_survives or not process_survives:
                for sock, _ in current.values():
                    if sock['connects']:
                        sock['invalid'] = True; issue(pid, 'udp_association_open_at_exit')
            if not table_survives:
                for sock,_ in current.values():released(sock)
            tables.pop(pid, None)
            continue
        match = re.match(r'^(\w+)\((.*)\)\s+=\s+(-?\d+)(?:<.*>)?(?:\(deleted\))?(?:\s.*)?$', line)
        if not match:
            attempted = re.match(r'^(\w+)\((\d+)(?:<[^>]*>)?', line)
            if attempted and attempted[1]=='close':
                fd=int(attempted[2])
                unknown_closes.append((current,fd,pid,sequence,task_ends.get(pid,final_sequence)))
                if fd in current:
                    sock=current[fd][0];sock['invalid']=True
                    for owner in sock['owners']|{pid}:issue(owner,'udp_close_result_unknown')
                elif re.match(r'^close\(\d+<UDP(?:v6)?:',line):
                    issue(pid,'udp_close_untracked_fd')
            if attempted and attempted[1] in WRITES:
                if int(attempted[2]) in current:
                    sock = current[int(attempted[2])][0]; sock['written'] = True; sock['invalid']=True
                    for owner in sock['owners']|{pid}:issue(owner,'udp_write_result_unknown')
                    writes.append((pid, sequence, attempted[1], sock))
                elif re.match(r'^\w+\(\d+<UDP(?:v6)?:',line):issue(pid,'udp_write_untracked_fd')
            continue  # Common parser owns incomplete/unknown records.
        call, args, result = match[1], match[2].strip(), int(match[3])
        first = re.match(r'(-?\d+)(?:<[^>]*>)?', args)
        fd = int(first[1]) if first else None
        if fd in current and call in WRITES | {'connect','close','dup','dup2','dup3','fcntl'}:
            pending_state(current[fd][0],pid)
        if call in ('dup2','dup3') and result in current:
            pending_state(current[result][0],pid)
        if result == 0 and (call in ('execve','execveat') or call == 'unshare' and 'CLONE_FILES' in args):
            for sock,_ in current.values():pending_state(sock,pid)
        if call == 'socket' and result >= 0:
            # The returned descriptor can be allocated after another thread's
            # interleaved acquisition, not at this syscall's entry stop. Never
            # treat a later TCP socket as the earlier pending UDP object.
            if result in current:
                previous=current[result][0];previous['invalid']=True
                for owner in previous['owners']|{pid}:issue(owner,'udp_fd_reused_without_close')
                remove(pid,result)
            fields = [value.strip() for value in args.split(',')]
            flags = {value.strip() for value in fields[1].split('|')} if len(fields) == 3 else set()
            if (len(fields) == 3 and fields[0] in {'AF_INET','AF_INET6'}
                    and 'SOCK_DGRAM' in flags and flags <= {'SOCK_DGRAM','SOCK_CLOEXEC','SOCK_NONBLOCK'}
                    and fields[2] in {'IPPROTO_UDP','IPPROTO_IP','0'}):
                sock = {'connects': [], 'written': False, 'owners': {task for task, shared in tables.items() if shared is current}, 'id': len(sockets),'lifetimeStart':sequence}
                sockets.append(sock); current[result] = (sock, 'SOCK_CLOEXEC' in args)
                acquisitions.append((current,result,sequence,sock))
                pending_state(sock,pid)
        elif call in ('clone', 'clone3', 'fork', 'vfork') and result > 0:
            translated = re.search(r"/\* (\d+) in strace's PID NS \*/", line)
            child = int(translated[1]) if translated else result
            tables[child] = current if 'CLONE_FILES' in args else dict(current)
            for sock, _ in current.values(): sock['owners'].add(child)
            if 'CLONE_FILES' not in args:
                for sock,_ in current.values():pending_state(sock,pid)
        elif call in ('execve', 'execveat') and result == 0:
            for sock,cloexec in current.values():
                if cloexec:released(sock)
            tables[pid] = {f: entry for f, entry in current.items() if not entry[1]}
        elif call == 'unshare' and result == 0 and 'CLONE_FILES' in args:
            tables[pid] = dict(current)
        elif call == 'close' and result == 0:
            remove(pid, fd)
        elif call == 'close_range' and result == 0:
            end = re.match(r'\d+,\s*(\d+|~0U)', args)
            if fd is None or end is None:
                issue(pid, 'udp_close_range_unknown'); continue
            last = 0xffffffff if end[1] == '~0U' else int(end[1])
            if 'UNSHARE' in args:
                for sock,_ in current.values():pending_state(sock,pid)
                current = dict(current); tables[pid] = current
            for f in list(current):
                if fd <= f <= last:
                    pending_state(current[f][0],pid)
                    if 'CLOEXEC' in args: current[f] = (current[f][0], True)
                    else: remove(pid, f)
        elif call in ('dup', 'dup2', 'dup3') or call == 'fcntl' and 'F_DUPFD' in args:
            if result >= 0:
                source = current.get(fd)
                if source is None and (re.match(r'\d+<UDP(?:v6)?:',args) or re.search(r'=\s+\d+<UDP(?:v6)?:',line)):
                    issue(pid,'udp_duplicate_untracked_fd')
                    # A joined close may have removed the numeric descriptor
                    # before its completion. Never lose a proven UDP duplicate.
                    for candidate in sockets:
                        if candidate['lifetimeStart']<=sequence<=candidate.get('lifetimeEnd',float('inf')):
                            candidate['invalid']=True;candidate['untrackedAlias']=True
                            candidate.pop('lifetimeEnd',None)
                            for owner in candidate['owners']:issue(owner,'udp_duplicate_untracked_fd')
                # dup2(fd, fd) is a no-op, including its CLOEXEC flag.
                if call == 'dup2' and fd == result: continue
                if result in current and call not in ('dup2','dup3'):
                    current[result][0]['invalid'] = True
                    issue(pid,'udp_fd_reused_without_close')
                remove(pid, result)
                if source:
                    current[result] = (source[0], 'CLOEXEC' in args)
                    acquisitions.append((current,result,sequence,source[0]))
        elif call == 'fcntl' and result == 0 and 'F_SETFD' in args and fd in current:
            current[fd] = (current[fd][0], 'FD_CLOEXEC' in args)
        elif call == 'connect' and fd in current:
            if re.match(r'\d+<TCP(?:v6)?:',args):
                current[fd][0]['invalid']=True
                for owner in current[fd][0]['owners']|{pid}:issue(owner,'udp_descriptor_kind_conflict')
            # Only IP destination connect events can be deferred. Disconnect
            # (AF_UNSPEC) does not erase an earlier association or write.
            if 'sa_family=AF_INET' in args:
                current[fd][0]['connects'].append((pid, sequence))
        elif call in WRITES:
            if fd in current:
                current[fd][0]['written'] = True
                writes.append((pid, sequence, call, current[fd][0]))
            # Kernel FD labels reveal imports (SCM_RIGHTS/pidfd_getfd) whose
            # acquisition/lifecycle was not captured: never exempt those.
            elif re.match(r'\d+<UDP(?:v6)?:', args): issue(pid, 'udp_write_untracked_fd')
    retire()
    # A decoded close with an unknown return has no proven effect time. The
    # original entry can precede a socket/alias acquired by another task in the
    # same shared table; no-network proof does not establish its FD lifecycle.
    for shared,fd,closer,start,end in unknown_closes:
        for acquired,number,when,sock in acquisitions:
            if acquired is shared and number==fd and start<when<end:
                sock['invalid']=True
                for owner in sock['owners']|{closer}:issue(owner,'udp_unknown_close_overlaps_fd_acquisition')
    # A register hole can hide a descriptor mutation even without networking.
    # Entry starts possible lifetime; removal cannot be proved before completion.
    for suspect,start,end in unknown_intervals:
        for sock in sockets:
            if (sock['connects'] and sock['lifetimeStart']<=end and
                    start<=sock.get('lifetimeEnd',float('inf'))):
                sock['invalid']=True
                for owner in sock['owners']|{suspect}:
                    issue(owner,'udp_lifetime_unparsed_register')
    for pid, current in tables.items():
        for sock, _ in current.values():
            if sock['connects']:
                sock['invalid'] = True; issue(pid, 'udp_association_missing_close')
    exempt = set(); contaminated = set()
    for sock in sockets:
        if not sock['connects']: continue
        groups = {tgid(pid) for pid in sock['owners']}
        for ring in (ring_evidence or {}).get('rings', []):
            for submission in ring['submissions']:
                if submission['opcode'] in WRITE_OPCODES | FD_MUTATING_OPCODES and (
                        ring['creatorTgid'] in groups or submission.get('tgid') in groups):
                    sock['invalid'] = True
                    reason=('udp_io_uring_write_fd_unproven' if submission['opcode'] in WRITE_OPCODES
                            else 'udp_io_uring_close_fd_unproven')
                    for pid in sock['owners']: issue(pid, reason)
        if sock['written']: contaminated.update(sock['connects'])
        elif not sock.get('invalid'): exempt.update(sock['connects'])
    return exempt, [(pid, sequence, call, sock['connects']) for pid, sequence, call, sock in writes], issues


def control(mode):
    """Run only inside a private, route-free control namespace."""
    import os
    import socket
    import subprocess
    import tempfile
    from pathlib import Path
    if mode in ('uring-writev','uring-async-writev'):
        from uring.probe import CONTROL_C
        source = CONTROL_C.replace('SOCK_STREAM', 'SOCK_DGRAM').replace('"127.0.0.1"', '"203.0.113.1"')
        source = source.replace('io_uring_prep_connect(io_uring_get_sqe(&ring),fd,(void*)&peer,sizeof(peer));',
            'connect(fd,(void*)&peer,sizeof(peer));\n'
            'struct iovec data={.iov_base="control",.iov_len=7};\n'
            'io_uring_prep_writev(io_uring_get_sqe(&ring),fd,&data,1,0);')
        if mode == 'uring-async-writev':
            source=source.replace('if(io_uring_submit(&ring)!=1)',
                                  'ring.sq.sqes[0].flags |= IOSQE_ASYNC;\n    if(io_uring_submit(&ring)!=1)')
        with tempfile.TemporaryDirectory(prefix='udp-uring-control-') as directory:
            c = Path(directory)/'control.c'; binary = Path(directory)/'control'
            c.write_text(source)
            subprocess.run(['cc',str(c),'-o',str(binary),'-luring'],check=True,capture_output=True)
            return subprocess.run([str(binary)],check=True).returncode
    if mode=='inherit-dup-send':
        from multiprocessing import get_context
        ready=get_context('fork').Semaphore(0)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        try: connection.connect(('203.0.113.1',443))
        except OSError: pass
        if mode == 'send':
            try: connection.send(b'control')
            except OSError: pass
        elif mode == 'inherit-dup-send':
            child = os.fork()
            if child == 0:
                # Wait on an untraced semaphore until the parent has returned from
                # fork. Keep inheritance distinct from the separate tests for
                # uncertain descriptor mutation across unfinished syscalls.
                ready.acquire()
                with socket.socket(fileno=os.dup(connection.fileno())) as duplicate:
                    try: duplicate.send(b'control')
                    except OSError: pass
                connection.close(); os._exit(0)
            ready.release()
            _, status = os.waitpid(child,0)
            if status: raise RuntimeError('UDP child control failed')
    return 0


def verify_controls(auditor, output):
    """Positive/negative transport controls with no external network interface."""
    import json
    import subprocess
    import sys
    output.mkdir(parents=True, exist_ok=True)
    results = []
    for mode in ('connect-close','send','inherit-dup-send','uring-writev','uring-async-writev'):
        report = output/(mode+'.json')
        command = ['sudo','-n','unshare','--net','--','/bin/sh','-c',
                   'ip link set lo up && exec "$@"','udp-control',
                   sys.executable,'-I','-B',str(auditor),'--report',str(report),'--',
                   sys.executable,'-I','-B',str(auditor),'--udp-control',mode]
        result = subprocess.run(command)
        data = json.loads(report.read_text())
        expected = 0 if mode=='connect-close' else 87 if mode.startswith('uring-') else 86
        if not (result.returncode==expected and data.get('commandExitCode')==0
                and data['ioUring']['recorded'] and data['ioUring']['capture']['drained']
                and data['ioUring']['capture']['lostEvents']==0):
            raise RuntimeError('Transport control failed: '+mode)
        if mode.startswith('uring-'):
            if not (data['externalAttempts']==1 and data['udpConnectOnly']==0 and data['unparsedRecords']==1
                    and data['classificationErrors']==1
                    and data['classificationIssues'][0]['reason']=='udp_io_uring_write_fd_unproven'):
                raise RuntimeError('io_uring UDP write control mismatch')
            if mode=='uring-async-writev':
                counts=data['ioUring']['capture']['kernelCounts']
                if not (counts.get('worker',0)>0 and counts.get('worker_enter')==counts.get('worker_return')):
                    raise RuntimeError('Forced asynchronous write did not qualify IO worker tracking')
        elif not (data['externalAttempts']==(0 if mode=='connect-close' else 2)
                  and data['unparsedRecords']==0 and data['classificationErrors']==0
                  and data['udpConnectOnly']==(1 if mode=='connect-close' else 0)):
            raise RuntimeError('UDP control classification mismatch: '+mode)
        results.append({'name':mode,'exitCode':result.returncode,**{key:data[key] for key in
                        ('externalAttempts','unparsedRecords','classificationErrors','udpConnectOnly')}})
    (output/'controls.json').write_text(json.dumps(results,indent=2)+'\n')
    return 0
