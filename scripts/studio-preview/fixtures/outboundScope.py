"""Parse buffer-suppressed strace records and select complete descendant trees.

Executable paths are used privately to identify roots. Reports contain PID/comm
and network metadata, never argv, environment, payloads or executable paths.
"""
import ipaddress
from pathlib import Path, PurePosixPath
import re

NETWORK = {'connect', 'send', 'sendto', 'sendmsg', 'sendmmsg', 'write', 'writev', 'accept', 'accept4'}
UDP_META = {'socket', 'unshare'}
FD_META = {'close','close_range','mmap','mmap2','dup','dup2','dup3','fcntl'}
FORK = {'clone', 'clone3', 'fork', 'vfork'}
EXEC = {'execve', 'execveat'}
IO_URING = {'io_uring_setup', 'io_uring_enter', 'io_uring_register'}
SETUP_FLAGS = {name:1<<index for index,name in enumerate([
    'IOPOLL','SQPOLL','SQ_AFF','CQSIZE','CLAMP','ATTACH_WQ','R_DISABLED','SUBMIT_ALL',
    'COOP_TASKRUN','TASKRUN_FLAG','SQE128','CQE32','SINGLE_ISSUER','DEFER_TASKRUN',
    'NO_MMAP','REGISTERED_FD_ONLY','NO_SQARRAY','HYBRID_IOPOLL'])}
PREFIX = re.compile(r'^(\d+)(?:<([^>]*)>)?\s+(.*)$')
CALL = re.compile(r'^(\w+)\(')
RESUMED = re.compile(r'^<\.\.\. (\w+) resumed>')
ADDR = re.compile(r'sa_family=AF_INET6?\b[^{}]*')
QUOTED = r'"(?:[^"\\]|\\.)*"'


def decode_path(quoted):
    """Decode only complete strace C strings (including UTF-8 octal filenames)."""
    value = quoted[1:-1]
    raw = bytearray()
    i = 0
    escapes = {'a': 7, 'b': 8, 'f': 12, 'n': 10, 'r': 13, 't': 9, 'v': 11, '\\': 92, '"': 34}
    while i < len(value):
        char = value[i]
        if char != '\\':
            raw.extend(char.encode('utf-8')); i += 1; continue
        i += 1
        if i == len(value):
            raise ValueError('Truncated path escape')
        match = re.match(r'[0-7]{1,3}', value[i:])
        if match:
            raw.append(int(match[0], 8)); i += len(match[0]); continue
        if value[i] == 'x' and re.match(r'[0-9a-fA-F]{2}', value[i+1:i+3]):
            raw.append(int(value[i+1:i+3], 16)); i += 3; continue
        if value[i] not in escapes:
            raise ValueError('Unknown path escape')
        raw.append(escapes[value[i]]); i += 1
    return raw.decode('utf-8', 'surrogateescape')


def canonical(value):
    return str(Path(value).resolve())


def analyze_processes(paths, scope_executables=(), require_executables=(), require_lifecycle=False, kernel_capture=None):
    """Scope by successful exec roots plus all forks/threads, never by address/name."""
    selected = {canonical(path) for path in scope_executables}
    required = {canonical(path) for path in require_executables}
    states, parents, roots, matches = {}, {}, set(), set()
    root_executables = {}
    fork_at, executions = {}, {}
    clone_threads, io_calls = {}, []
    sequence = 0
    classification_issues = []
    observed_order = []
    udp_records = []
    pending = {}
    terminal_stops, killed_at = {}, {}
    invalid_terminal_stops = set()

    def state(pid, name=None):
        if pid not in states:
            states[pid] = {'pid': pid, 'process': 'unknown', 'events': [], 'unparsed': 0, 'finished': False,
                           'io_uring': [], 'external_accepts':0}
            observed_order.append(pid)
        if name and re.fullmatch(r'[A-Za-z0-9_.+ -]{1,64}', name):
            states[pid]['process'] = name
        return states[pid]

    def classification_issue(reason, pid=None, call=None):
        # Only fixed reason codes and numeric task identities enter reports.
        # Never include trace text, executable paths, argv or environment.
        issue = {'reason': reason}
        if pid is not None: issue['pid'] = pid
        if call in FORK | EXEC: issue['syscall'] = call
        classification_issues.append(issue)

    def unknown(pid, call):
        if call in NETWORK:
            state(pid)['unparsed'] += 1
        elif call in IO_URING:
            state(pid)['io_uring'].append(call)
            io_calls.append({'pid':pid,'call':call,'result':None,'fd':None,'flags':None,'sequence':0})
        elif call in FD_META | UDP_META:
            state(pid)['unparsed'] += 1
        else:
            classification_issue('incomplete_syscall', pid, call)

    def record(pid, line, started):
        item = state(pid)
        udp_records.append((pid, line, started))
        if line.startswith('+++'):
            if re.match(r'^\+\+\+ (?:exited with |killed by |superseded by execve in pid )', line):
                item['finished'] = True
                if line.startswith('+++ killed by '): killed_at[pid] = started
            else:
                classification_issue('unknown_terminal_record', pid)
            return
        match = CALL.match(line)
        if not match:
            if line and not line.startswith(('+++', '---')):
                classification_issue('unknown_record', pid)
            return
        call = match[1]
        if call in NETWORK | FD_META | UDP_META and not re.search(r'\)\s+=\s+(?:-?\d+|0x[0-9a-f]+)(?:<.*>)?(?:\(deleted\))?(?:\s.*)?$', line):
            item['unparsed'] += 1
        if call in UDP_META: return
        if call in FD_META:
            # Only ring-labelled descriptors and bulk close operations matter.
            # Ordinary file paths and mmap addresses never enter reports.
            if call not in ('close_range','dup2','dup3') and not re.search(r'anon_inode[^>]*io_uring',line):return
            args=re.match(r'^\w+\((-?\d+)(?:<[^>]*>)?(?:,\s*(\d+))?',line)
            ring_fd=re.search(r'(-?\d+)<anon_inode[^>]*io_uring[^>]*>',line)
            result=re.search(r'\)\s+=\s+(-?\d+|0x[0-9a-f]+)',line)
            entry={'pid':pid,'call':call,'sequence':started,'result':int(result[1],0) if result else None,
                   'fd':int(ring_fd[1]) if call in ('mmap','mmap2') and ring_fd else int(args[1]) if args else None}
            entry.update(cloexec='CLOEXEC' in line,duplicate=call.startswith('dup') or 'F_DUPFD' in line,
                         setfd='F_SETFD' in line,lastFd=(int(args[2]) if args and args[2] else
                         0xffffffff if call=='close_range' and '~0U' in line else None))
            entry['unshare']='CLOSE_RANGE_UNSHARE' in line
            io_calls.append(entry);return
        if call in IO_URING:
            # Submission queues may perform networking without connect/send*
            # syscalls. Even denied setup or an inherited-ring enter/register
            # makes this task's network evidence unsupported, never zero.
            item['io_uring'].append(call)
            result=re.search(r'\)\s+=\s+(-?\d+)(?:<[^>]*>)?(?:\s.*)?$',line)
            entry={'pid':pid,'call':call,'sequence':started,'result':int(result[1]) if result else None}
            error=re.search(r'=\s+-1\s+(\w+)',line)
            entry['error']=error[1] if error else None
            entry['registeredRing']='REGISTERED_RING' in line or 'REGISTER_RING_FDS' in line
            if call=='io_uring_setup':
                flag_match=re.search(r'\bflags=([^,}]+)',line)
                value=0
                try:
                    for token in (re.sub(r'/\*.*?\*/','',flag_match[1]).strip().split('|') if flag_match else ['UNKNOWN']):
                        value |= SETUP_FLAGS[token.removeprefix('IORING_SETUP_')] if token.startswith('IORING_SETUP_') else int(token,0)
                    entry['flags']=value
                except (KeyError,ValueError):entry['flags']=None
            else:
                fd=re.match(r'^\w+\((-?\d+)(?:<[^>]*>)?,',line)
                entry['fd']=int(fd[1]) if fd else None
            io_calls.append(entry)
            return
        if call in FORK:
            result = re.search(r'\)\s+=\s+(-?\d+)(?:<[^>]*>)?(.*)$', line)
            if not result:
                classification_issue('unknown_fork_result', pid, call); return
            child = int(result[1])
            translated = re.search(r"/\* (\d+) in strace's PID NS \*/", result[2])
            if child > 0 and translated:
                child = int(translated[1])
            if child > 0:
                if child == pid or child in parents:
                    classification_issue('conflicting_fork_edge', child, call)
                else:
                    parents[child] = pid
                    fork_at[child] = started
                    clone_threads[child] = 'CLONE_THREAD' in line
                    io_calls.append({'call':'fork','pid':pid,'child':child,'shareFiles':'CLONE_FILES' in line,
                                     'sequence':started,'result':child})
            return
        if call in EXEC:
            if not re.search(r'=\s+0(?:\s|$)', line):
                if '= -1 ' not in line: classification_issue('unknown_exec_result', pid, call)
                return
            pattern = rf'^execve\(({QUOTED}),' if call == 'execve' else rf'^execveat\([^,]+, ({QUOTED}),'
            filename = re.match(pattern, line)
            if not filename:
                classification_issue('unknown_exec_filename', pid, call); return
            try:
                executable = decode_path(filename[1])
                # Trace filenames always follow Linux/POSIX rules, including offline tests on Windows.
                if not PurePosixPath(executable).is_absolute():
                    if selected: classification_issue('relative_exec_filename', pid, call)
                    return
            except (OSError, ValueError, RuntimeError):
                classification_issue('invalid_exec_filename', pid, call); return
            executions.setdefault(pid, []).append((started, executable))
            io_calls.append({'call':'exec','pid':pid,'sequence':started,'result':0})
            return
        if call not in NETWORK:
            classification_issue('unknown_syscall', pid); return
        accepted=call in ('accept','accept4')
        if accepted and re.search(r'=\s+-1\b',line):return
        def destination(address, port):
            try:
                parsed = ipaddress.ip_address(address.strip('[]'))
                port = int(port)
                if not 0 <= port <= 65535: raise ValueError('Invalid port')
            except ValueError:
                item['unparsed'] += 1; return
            effective = parsed.ipv4_mapped if isinstance(parsed, ipaddress.IPv6Address) else None
            local = (effective or parsed).is_loopback and port != 53
            if accepted and not local:item['external_accepts']+=1
            item['events'].append({'pid': pid, 'process': item['process'], 'syscall': call,
                                   'address': str(parsed), 'port': port, 'external': not local and not accepted,
                                   'direction':'inbound' if accepted else 'outbound',
                                   '_sequence': started, 'failed': bool(re.search(r'= -1\b', line))})

        destinations = ADDR.findall(line)
        if not destinations and 'sa_family=AF_' in line and not any(
                family in line for family in ('AF_UNIX', 'AF_NETLINK', 'AF_UNSPEC')):
            item['unparsed'] += 1
        for value in destinations:
            address = re.search(r'(?:inet_addr\(|inet_pton\(AF_INET6, )"([^"]+)"', value)
            port = re.search(r'sin6?_port=htons\((\d+)\)', value)
            if not address or not port:
                item['unparsed'] += 1; continue
            destination(address[1], port[1])
        if accepted and not destinations and not any(family in line for family in ('AF_UNIX','UNIX')):
            peer=re.search(r'=\s+\d+<(?:TCP|UDP)(?:v6)?:\[(.*?)\]>',line)
            if peer and '->' in peer[1]:
                address,separator,port=peer[1].rsplit('->',1)[1].rpartition(':')
                if separator:destination(address,port)
                else:item['unparsed']+=1
            else:item['unparsed']+=1
        # A selected child can inherit an already-connected socket from an
        # unselected parent. Decode the peer at send time; its connect need not
        # have happened inside the selected tree. -yy provides kernel FD peers.
        null_count = (1 if call in ('send', 'write', 'writev') and re.match(r'\w+\(\d+<(?:TCP|UDP)(?:v6)?:\[[^>]*->', line) else
                      1 if call == 'sendto' and re.search(r', NULL, 0\s*\)\s+=', line) else
                      len(re.findall(r'msg_name=NULL', line)) if call in ('sendmsg', 'sendmmsg') else 0)
        if not destinations and not any(family in line for family in ('AF_UNIX', 'AF_NETLINK', 'AF_UNSPEC')):
            if call == 'connect' or call in ('send', 'sendto', 'sendmsg', 'sendmmsg') and not null_count:
                item['unparsed'] += 1
        if call in ('write', 'writev') and re.match(r'\w+\(\d+<socket:', line):
            item['unparsed'] += 1
        if call == 'sendmmsg' and 'msg_name=' not in line:
            item['unparsed'] += 1
        if null_count:
            fd = re.match(r'^\w+\(\d+<(.+?)>,', line)
            peer = fd[1] if fd else ''
            if peer.startswith(('UNIX', 'NETLINK')) or re.fullmatch(r'UDP(?:v6)?:\[[^>]*\]', peer) and '->' not in peer:
                return
            connection = re.fullmatch(r'(?:TCP|UDP)(?:v6)?:\[(.*)\]', peer)
            if not connection or '->' not in connection[1]:
                item['unparsed'] += null_count
            else:
                address, separator, port = connection[1].rsplit('->', 1)[1].rpartition(':')
                if not separator:
                    item['unparsed'] += null_count
                else:
                    for _ in range(null_count): destination(address, port)

    for index, path in enumerate(sorted(paths)):
        legacy_pid = int(path.suffix[1:]) if path.suffix[1:].isdigit() else -(index+1)
        for raw in path.read_text().splitlines():
            sequence += 1
            if not raw: continue
            prefix = PREFIX.match(raw)
            if prefix:
                pid, name, line = int(prefix[1]), prefix[2], prefix[3]
            else:
                pid, name, line = legacy_pid, None, raw
                if selected and line: classification_issue('missing_task_prefix', pid)
            state(pid, name)
            # strace can fail to read registers when a task is killed at a
            # syscall-entry stop. Its exact stub has no resumed syscall, exec
            # success or fork result. Attribute it to its captured PID only if
            # the next/last record for that task is its signal-death record.
            # Missing edges, pending fork/exec and every other unknown stay fatal.
            if pid in terminal_stops and (not line.startswith('+++ killed by ') or pid in killed_at):
                invalid_terminal_stops.add(pid)
            if line == '???( <unfinished ...>':
                if pid in pending or pid in terminal_stops:
                    invalid_terminal_stops.add(pid)
                terminal_stops[pid] = sequence
                continue
            call = CALL.match(line)
            resumed = RESUMED.match(line)
            if '<unfinished ...>' in line:
                if pid in pending:
                    unknown(pid, pending[pid][0])
                if not call:
                    classification_issue('unknown_unfinished_syscall', pid); continue
                pending[pid] = (call[1], line.replace('<unfinished ...>', ''), sequence)
                continue
            started = sequence
            if resumed:
                previous = pending.pop(pid, None)
                if not previous or resumed[1] != previous[0]:
                    unknown(pid, resumed[1]); continue
                line = previous[1] + line.split(' resumed>', 1)[1]
                started = previous[2]
            record(pid, line, started)
    for pid, (call, _line, _started) in pending.items():
        unknown(pid, call)
    for pid, at in terminal_stops.items():
        if pid in invalid_terminal_stops or killed_at.get(pid, 0) <= at:
            classification_issue('unknown_unfinished_syscall', pid)
        else:
            # An attributable decode failure remains unparsed in this PID's
            # tree. It blocks selected trees and whole-command enforcement;
            # an unselected sibling is retained in the report-only measurement.
            state(pid)['unparsed'] += 1

    # Resolve /proc/self/exe from the captured executable inherited at fork,
    # never from the auditor's /proc or from a mutable process/thread name.
    # Fork entry positions also handle children that exec before parent resume.
    cache = {}
    resolving = set()
    def image_before(pid, before):
        key = (pid, before)
        if key in cache: return cache[key]
        if key in resolving: return None
        resolving.add(key)
        previous = [(at, path) for at, path in executions.get(pid, []) if at < before]
        if previous:
            at, path = max(previous)
            if path in ('/proc/self/exe', '/proc/thread-self/exe'):
                result = image_before(pid, at)
            elif re.fullmatch(r'/proc/\d+/exe', path):
                # A number inside a pathname is namespace-local and has no
                # typed strace translation. Do not mistake it for a tracer PID.
                result = None
            elif path.startswith('/proc/'):
                result = None
            else:
                result = canonical(path)
        elif pid in parents:
            result = image_before(parents[pid], fork_at[pid])
        else:
            result = None
        resolving.remove(key); cache[key] = result
        return result

    for pid, entries in executions.items():
        for at, _path in entries:
            executable = image_before(pid, at + 1)
            if executable is None:
                if selected: classification_issue('unresolved_exec_image', pid)
            elif executable in selected:
                roots.add(pid); matches.add(executable)
                root_executables[pid] = Path(executable).name

    if require_lifecycle:
        for pid, item in states.items():
            if not item['finished']: classification_issue('missing_terminal_record', pid)
    if (selected or require_lifecycle) and states:
        # The traced command is the only permitted parentless task. Every other
        # PID/TID must have a captured fork edge, including reparented descendants.
        for pid in states:
            if pid != observed_order[0] and pid not in parents: classification_issue('missing_fork_edge', pid)
        if selected and not roots: classification_issue('missing_selected_root')
        for child in parents:
            if child not in states: classification_issue('missing_child_records', child)
        for _ in required - matches: classification_issue('missing_required_executable')
        for child in parents:
            seen = set()
            current = child
            while current in parents:
                if current in seen:
                    classification_issue('cyclic_fork_edges', child); break
                seen.add(current); current = parents[current]
    included = set(roots)
    while selected:
        more = {child for child, parent in parents.items() if parent in included} - included
        if not more: break
        included.update(more)

    def tgid(pid):
        seen=set()
        while clone_threads.get(pid):
            if pid in seen:return None
            seen.add(pid);pid=parents.get(pid)
        return pid

    ring_evidence=None
    if kernel_capture is not None:
        from uring.policy import reconcile
        for call in io_calls:
            call['tgid']=tgid(call['pid'])
            if call['call']=='fork':call['childTgid']=tgid(call['child'])
        ring_evidence=reconcile(kernel_capture,io_calls,set(states),included if selected else set(states))
        classification_issues.extend(ring_evidence['globalIssues'])

    from udpLifecycle import analyze as analyze_udp
    exempt, udp_writes, udp_issues = analyze_udp(udp_records, ring_evidence, tgid)
    for issue in udp_issues:
        state(issue['pid'])
    event_keys = {(pid, event['_sequence']): event for pid, item in states.items() for event in item['events']}
    for pid, sequence, call, connects in udp_writes:
        if (pid, sequence) not in event_keys and connects:
            origin = event_keys.get(connects[-1])
            if origin:
                states[pid]['events'].append({**origin, 'pid': pid, 'process': states[pid]['process'],
                    'syscall': call, '_sequence': sequence, 'failed': True})
    for pid, item in states.items():
        for event in item['events']:
            key = (pid, event.pop('_sequence'))
            event['udpAssociationOnly'] = event['syscall'] == 'connect' and key in exempt
            if event['udpAssociationOnly']: event['external'] = False

    def report(pids, scope):
        events = [event for pid in pids for event in states[pid]['events']]
        external = [event for event in events if event['external']]
        processes = []
        issues = classification_issues + [issue for issue in udp_issues if issue['pid'] in pids] + ([issue for pid in pids for issue in ring_evidence['issuesByPid'].get(pid,[])]
            if ring_evidence is not None else [
                {'reason': 'unsupported_io_uring', 'pid': pid, 'syscall': call}
                for pid in sorted(pids) for call in states[pid]['io_uring']])
        issues += [{'reason':'unsupported_external_accept','pid':pid} for pid in pids
                   for _ in range(states[pid]['external_accepts'])]
        for pid in sorted(pids):
            item = states[pid]
            processes.append({'pid': pid, 'parentPid': parents.get(pid), 'process': item['process'],
                              'inScope': not selected or pid in included, 'root': pid in roots, 'finished': item['finished'],
                              'destinationAttempts': len(item['events']),
                              'externalAttempts': sum(event['external'] for event in item['events']),
                              'ioUringSyscalls': item['io_uring'],
                              'unparsedRecords': item['unparsed']})
        return {'schema': 'aelix-studio-host.outbound-audit/1', 'scope': scope,
                'traceFiles': len(paths), 'processCount': len(pids), 'rootPids': sorted(roots),
                'rootExecutables': [{'pid': pid, 'executable': root_executables[pid]} for pid in sorted(roots)],
                'destinationAttempts': len(events), 'externalAttempts': len(external),
                'udpConnectOnly': sum(event['udpAssociationOnly'] for event in events),
                'udpAssociations': [event for event in events if event['udpAssociationOnly']],
                'unparsedRecords': sum(states[pid]['unparsed'] for pid in pids) + len(issues),
                'classificationErrors': len(issues), 'classificationIssues': issues,
                'external': external, 'processes': processes,
                'ioUring': ({'recorded':kernel_capture.get('complete',False),'opcodeCounts':ring_evidence['selectedOpcodeCounts'] if scope=='selected-process-trees' else ring_evidence['opcodeCounts'],
                             'policy':'node-v24.11.0-libuv-explicit-file-and-epoll',
                             'capture':{k:kernel_capture.get(k) for k in ('complete','drained','lostEvents','eventCount','namespaceInode','pidNamespaceVerified','root','kernelCounts','recordErrors','recorderExitCode','tool','toolVersion','kernel','tracepoints','formatSha256','programSha256','pidNumbersOffset','reason','diagnostics')},
                             'rings':[r for r in ring_evidence['rings'] if r['creatorPid'] in pids]}
                            if ring_evidence is not None else {'recorded':False})}

    whole = report(set(states), 'all')
    scoped = report(set(states) & included, 'selected-process-trees') if selected else whole
    return scoped, whole
