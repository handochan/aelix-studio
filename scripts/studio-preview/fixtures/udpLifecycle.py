"""Prove that UDP associations closed without any write through any FD alias.

No destination exceptions. Uncertain ownership/lifecycle is fatal. Kernel
tracepoints do not expose the submitted FD: a write submission in a process
that held an association conservatively prevents its exemption (even when
relative syscall/kernel timing cannot prove overlap).
"""
import re

WRITES = {'send', 'sendto', 'sendmsg', 'sendmmsg', 'write', 'writev'}
WRITE_OPCODES = {2, 5, 9, 23, 26, 47, 48, 50, 57, 58, 60}


def analyze(records, ring_evidence, tgid):
    tables = {}; sockets = []; issues = []; writes = []

    def issue(pid, reason):
        entry = {'pid': pid, 'reason': reason}
        if entry not in issues: issues.append(entry)

    def table(pid):
        return tables.setdefault(pid, {})

    def remove(pid, fd):
        table(pid).pop(fd, None)

    for pid, line, sequence in sorted(records, key=lambda item: item[2]):
        current = table(pid)
        if line.startswith('+++'):
            # Threads may share an FD table; final table owner must have closed
            # every association. Process exit is not proof of an explicit close.
            if not any(other is current for task, other in tables.items() if task != pid):
                for sock, _ in current.values():
                    if sock['connects']:
                        sock['invalid'] = True; issue(pid, 'udp_association_open_at_exit')
            tables.pop(pid, None)
            continue
        match = re.match(r'^(\w+)\((.*)\)\s+=\s+(-?\d+)(?:<.*>)?(?:\s.*)?$', line)
        if not match:
            attempted = re.match(r'^(\w+)\((\d+)(?:<[^>]*>)?', line)
            if attempted and attempted[1] in WRITES and int(attempted[2]) in current:
                sock = current[int(attempted[2])][0]; sock['written'] = True
                writes.append((pid, sequence, attempted[1], sock))
            continue  # Common parser owns incomplete/unknown records.
        call, args, result = match[1], match[2], int(match[3])
        first = re.match(r'(-?\d+)(?:<[^>]*>)?', args)
        fd = int(first[1]) if first else None
        if call == 'socket' and result >= 0:
            if re.fullmatch(r'AF_INET6?,\s*SOCK_DGRAM(?:\|SOCK_\w+)*,\s*(?:IPPROTO_UDP|IPPROTO_IP|0)', args):
                if result in current: issue(pid, 'udp_fd_reused_without_close')
                sock = {'connects': [], 'written': False, 'owners': {task for task, shared in tables.items() if shared is current}, 'id': len(sockets)}
                sockets.append(sock); current[result] = (sock, 'SOCK_CLOEXEC' in args)
        elif call in ('clone', 'clone3', 'fork', 'vfork') and result > 0:
            translated = re.search(r"/\* (\d+) in strace's PID NS \*/", line)
            child = int(translated[1]) if translated else result
            tables[child] = current if 'CLONE_FILES' in args else dict(current)
            for sock, _ in current.values(): sock['owners'].add(child)
        elif call in ('execve', 'execveat') and result == 0:
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
                current = dict(current); tables[pid] = current
            for f in list(current):
                if fd <= f <= last:
                    if 'CLOEXEC' in args: current[f] = (current[f][0], True)
                    else: remove(pid, f)
        elif call in ('dup', 'dup2', 'dup3') or call == 'fcntl' and 'F_DUPFD' in args:
            if result >= 0:
                source = current.get(fd)
                # dup2(fd, fd) is a no-op, including its CLOEXEC flag.
                if call == 'dup2' and fd == result: continue
                remove(pid, result)
                if source: current[result] = (source[0], 'CLOEXEC' in args)
        elif call == 'fcntl' and result == 0 and 'F_SETFD' in args and fd in current:
            current[fd] = (current[fd][0], 'FD_CLOEXEC' in args)
        elif call == 'connect' and fd in current:
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
                if submission['opcode'] in WRITE_OPCODES and (
                        ring['creatorTgid'] in groups or submission.get('tgid') in groups):
                    sock['invalid'] = True
                    for pid in sock['owners']: issue(pid, 'udp_io_uring_write_fd_unproven')
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
    if mode == 'uring-writev':
        from uring.probe import CONTROL_C
        source = CONTROL_C.replace('SOCK_STREAM', 'SOCK_DGRAM').replace('"127.0.0.1"', '"203.0.113.1"')
        source = source.replace('io_uring_prep_connect(io_uring_get_sqe(&ring),fd,(void*)&peer,sizeof(peer));',
            'connect(fd,(void*)&peer,sizeof(peer));\n'
            'struct iovec data={.iov_base="control",.iov_len=7};\n'
            'io_uring_prep_writev(io_uring_get_sqe(&ring),fd,&data,1,0);')
        with tempfile.TemporaryDirectory(prefix='udp-uring-control-') as directory:
            c = Path(directory)/'control.c'; binary = Path(directory)/'control'
            c.write_text(source)
            subprocess.run(['cc',str(c),'-o',str(binary),'-luring'],check=True,capture_output=True)
            return subprocess.run([str(binary)],check=True).returncode
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        try: connection.connect(('203.0.113.1',443))
        except OSError: pass
        if mode == 'send':
            try: connection.send(b'control')
            except OSError: pass
        elif mode == 'inherit-dup-send':
            child = os.fork()
            if child == 0:
                with socket.socket(fileno=os.dup(connection.fileno())) as duplicate:
                    try: duplicate.send(b'control')
                    except OSError: pass
                connection.close(); os._exit(0)
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
    for mode in ('connect-close','send','inherit-dup-send','uring-writev'):
        report = output/(mode+'.json')
        command = ['sudo','-n','unshare','--net','--','/bin/sh','-c',
                   'ip link set lo up && exec "$@"','udp-control',
                   sys.executable,'-I','-B',str(auditor),'--report',str(report),'--',
                   sys.executable,'-I','-B',str(auditor),'--udp-control',mode]
        result = subprocess.run(command)
        data = json.loads(report.read_text())
        expected = 0 if mode=='connect-close' else 87 if mode=='uring-writev' else 86
        if not (result.returncode==expected and data.get('commandExitCode')==0
                and data['ioUring']['recorded'] and data['ioUring']['capture']['drained']
                and data['ioUring']['capture']['lostEvents']==0):
            raise RuntimeError('Transport control failed: '+mode)
        if mode=='uring-writev':
            if not (data['externalAttempts']==1 and data['udpConnectOnly']==0 and data['unparsedRecords']==1
                    and data['classificationErrors']==1
                    and data['classificationIssues'][0]['reason']=='udp_io_uring_write_fd_unproven'):
                raise RuntimeError('io_uring UDP write control mismatch')
        elif not (data['externalAttempts']==(0 if mode=='connect-close' else 2)
                  and data['unparsedRecords']==0 and data['classificationErrors']==0
                  and data['udpConnectOnly']==(1 if mode=='connect-close' else 0)):
            raise RuntimeError('UDP control classification mismatch: '+mode)
        results.append({'name':mode,'exitCode':result.returncode,**{key:data[key] for key in
                        ('externalAttempts','unparsedRecords','classificationErrors','udpConnectOnly')}})
    (output/'controls.json').write_text(json.dumps(results,indent=2)+'\n')
    return 0
