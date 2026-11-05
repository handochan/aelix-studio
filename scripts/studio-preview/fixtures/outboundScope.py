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
    terminal_stops = {}
    terminal_at, terminal_shapes = {}, {}
    register_holes, hole_resumes = {}, set()
    result_holes = {}
    invalid_terminal_stops = set()

    def state(pid, name=None):
        if pid not in states:
            states[pid] = {'pid': pid, 'process': 'unknown', 'events': [], 'unparsed': 0, 'finished': False,
                           'io_uring': [], 'external_accepts':0,'unparsed_kinds':{}}
            observed_order.append(pid)
        if name and re.fullmatch(r'[A-Za-z0-9_.+ -]{1,64}', name):
            states[pid]['process'] = name
        return states[pid]

    def unparsed(pid, kind, count=1, call=None):
        item=state(pid)
        key=kind+(':'+call if call in NETWORK | FD_META | UDP_META else '')
        item['unparsed']+=count
        item['unparsed_kinds'][key]=item['unparsed_kinds'].get(key,0)+count
        if item['unparsed_kinds'][key]==0:del item['unparsed_kinds'][key]

    def classification_issue(reason, pid=None, call=None):
        # Only fixed reason codes and numeric task identities enter reports.
        # Never include trace text, executable paths, argv or environment.
        issue = {'reason': reason}
        if pid is not None: issue['pid'] = pid
        if call in FORK | EXEC: issue['syscall'] = call
        classification_issues.append(issue)

    def unknown(pid, call, kind='incomplete'):
        if call in NETWORK:
            unparsed(pid,kind,call=call)
        elif call in IO_URING:
            state(pid)['io_uring'].append(call)
            io_calls.append({'pid':pid,'call':call,'result':None,'fd':None,'flags':None,'sequence':0})
        elif call in FD_META | UDP_META:
            unparsed(pid,kind,call=call)
        else:
            classification_issue('incomplete_syscall', pid, call)

    def record(pid, line, started):
        item = state(pid)
        # Joining an unfinished entry can introduce whitespace immediately
        # after '('; it is lexical whitespace, not an unknown destination.
        line = re.sub(r'^(\w+\()\s+', r'\1', line)
        udp_records.append((pid, line, started, sequence))
        if line.startswith('+++'):
            if re.match(r'^\+\+\+ (?:exited with |killed by |superseded by execve in pid )', line):
                item['finished'] = True
                if line.startswith(('+++ killed by ','+++ exited with ')):terminal_at[pid]=started
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
            unparsed(pid,'result',call=call)
            if call in NETWORK or call=='close': result_holes[(pid,started)]=call
        if call in UDP_META:
            if call=='unshare' and 'CLONE_FILES' in line:
                result=re.search(r'\)\s+=\s+(-?\d+)(?:\s.*)?$',line)
                io_calls.append({'pid':pid,'call':'unshare','sequence':started,
                                 'result':int(result[1]) if result else None})
            return
        if call in FD_META:
            # Track numeric FD transitions even when -yy could not annotate a
            # ring alias. File paths and mmap addresses never enter reports.
            ring_label=bool(re.search(r'anon_inode[^>]*io_uring',line))
            unknown_close=call=='close' and (pid,started) in result_holes
            args=re.match(r'^\w+\((-?\d+)(?:<[^>]*>)?(?:,\s*(\d+))?',line)
            ring_fd=re.search(r'(-?\d+)<anon_inode[^>]*io_uring[^>]*>',line)
            mapped_fd=re.match(r'^\w+\([^,]*,[^,]*,[^,]*,[^,]*,\s*(-?\d+)',line) if call in ('mmap','mmap2') else None
            result=re.search(r'\)\s+=\s+(-?\d+|0x[0-9a-f]+)',line)
            entry={'pid':pid,'call':call,'sequence':started,'result':int(result[1],0) if result else None,
                   'fd':((int(mapped_fd[1]) if mapped_fd else int(ring_fd[1]) if ring_fd else None)
                         if call in ('mmap','mmap2') else int(args[1]) if args else None),
                   'genericMetadata':not ring_label and call not in ('close_range','dup2','dup3')}
            if unknown_close:
                entry['result']=None
                entry['genericClose']=not ring_label
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
                unparsed(pid,'invalid_destination',call=call); return
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
            unparsed(pid,'unknown_address_family',call=call)
        for value in destinations:
            address = re.search(r'(?:inet_addr\(|inet_pton\(AF_INET6, )"([^"]+)"', value)
            port = re.search(r'sin6?_port=htons\((\d+)\)', value)
            if not address or not port:
                unparsed(pid,'address_fields',call=call); continue
            destination(address[1], port[1])
        if accepted and not destinations and not any(family in line for family in ('AF_UNIX','UNIX')):
            peer=re.search(r'=\s+\d+<(?:TCP|UDP)(?:v6)?:\[(.*?)\]>',line)
            if peer and '->' in peer[1]:
                address,separator,port=peer[1].rsplit('->',1)[1].rpartition(':')
                if separator:destination(address,port)
                else:unparsed(pid,'accept_peer',call=call)
            else:unparsed(pid,'accept_peer',call=call)
        # A selected child can inherit an already-connected socket from an
        # unselected parent. Decode the peer at send time; its connect need not
        # have happened inside the selected tree. -yy provides kernel FD peers.
        null_count = (1 if call in ('send', 'write', 'writev') and re.match(r'\w+\(\d+<(?:TCP|UDP)(?:v6)?:\[[^>]*->', line) else
                      1 if call == 'sendto' and re.search(r', NULL, 0\s*(?:\)\s+=|$)', line) else
                      len(re.findall(r'msg_name=NULL', line)) if call in ('sendmsg', 'sendmmsg') else 0)
        if not destinations and not any(family in line for family in ('AF_UNIX', 'AF_NETLINK', 'AF_UNSPEC')):
            if call == 'connect' or call in ('send', 'sendto', 'sendmsg', 'sendmmsg') and not null_count:
                unparsed(pid,'destination',call=call)
        if call in ('write', 'writev') and re.match(r'\w+\(\d+<socket:', line):
            unparsed(pid,'socket_peer',call=call)
        if call == 'sendmmsg' and 'msg_name=' not in line:
            unparsed(pid,'message_vector',call=call)
        if null_count:
            fd = re.match(r'^\w+\(\d+<(.+?)>,', line)
            peer = fd[1] if fd else ''
            if peer.startswith(('UNIX', 'NETLINK')) or re.fullmatch(r'UDP(?:v6)?:\[[^>]*\]', peer) and '->' not in peer:
                return
            connection = re.fullmatch(r'(?:TCP|UDP)(?:v6)?:\[(.*)\]', peer)
            if not connection or '->' not in connection[1]:
                unparsed(pid,'send_peer',null_count,call)
            else:
                address, separator, port = connection[1].rsplit('->', 1)[1].rpartition(':')
                if not separator:
                    unparsed(pid,'send_peer',null_count,call)
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
            # Keep register stubs blocking until independent kernel proof.
            # With kernel evidence, signal notifications and normal termination
            # can delimit the same final hole. Known calls, ambiguous edges,
            # pending fork/exec and post-termination records remain fatal.
            unreadable_resume = line == '<... ??? resumed>) = ?'
            signal_record=line.startswith('--- SIG')
            final_record=line.startswith('+++ killed by ') or kernel_capture is not None and line.startswith('+++ exited with ')
            if pid in terminal_stops:
                shape=('signal' if signal_record else 'resume' if unreadable_resume else
                       'exit' if final_record else 'register-entry' if line=='???( <unfinished ...>' else 'other')
                if len(terminal_shapes[pid])<8:terminal_shapes[pid].append(shape)
                if pid in terminal_at or not (final_record or unreadable_resume or kernel_capture is not None and signal_record):
                    invalid_terminal_stops.add(pid)
            if line == '???( <unfinished ...>':
                if pid in pending or pid in terminal_stops:
                    invalid_terminal_stops.add(pid)
                terminal_stops[pid] = sequence
                register_holes[pid] = register_holes.get(pid, 0) + 1
                terminal_shapes.setdefault(pid,['register-entry'])
                continue
            if unreadable_resume:
                if pid not in terminal_stops or pid in hole_resumes:
                    classification_issue('unknown_resumed_syscall', pid)
                else:
                    hole_resumes.add(pid)
                    register_holes[pid] += 1
                continue
            call = CALL.match(line)
            resumed = RESUMED.match(line)
            if '<unfinished ...>' in line:
                if pid in pending:
                    unknown(pid, pending[pid][0],'overwritten_entry')
                if not call:
                    classification_issue('unknown_unfinished_syscall', pid); continue
                pending[pid] = (call[1], line.replace('<unfinished ...>', ''), sequence)
                continue
            started = sequence
            if resumed:
                previous = pending.pop(pid, None)
                if not previous or resumed[1] != previous[0]:
                    unknown(pid, resumed[1],'unmatched_resume'); continue
                line = previous[1] + line.split(' resumed>', 1)[1]
                started = previous[2]
            record(pid, line, started)
    for pid, (call, _line, _started) in pending.items():
        if kernel_capture is not None and call in NETWORK | {'close'}:
            record(pid,_line,_started)
        else: unknown(pid, call,'pending_at_end')
    for pid, at in terminal_stops.items():
        if pid in invalid_terminal_stops or terminal_at.get(pid, 0) <= at:
            classification_issue('unknown_unfinished_syscall', pid)
            classification_issues[-1]['registerRecordKinds']=terminal_shapes[pid]
        else:
            # An attributable decode failure remains unparsed in this PID's
            # tree. It blocks selected trees and whole-command enforcement;
            # an unselected sibling is retained in the report-only measurement.
            unparsed(pid,'register_stub',register_holes[pid])

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
    intervals=[(pid,start,terminal_at[pid]) for pid,start in terminal_stops.items()
               if pid not in invalid_terminal_stops and terminal_at.get(pid,0)>start] if kernel_capture is not None else []
    udp_metadata={}
    exempt, udp_writes, udp_issues = analyze_udp(udp_records, ring_evidence, tgid, intervals, udp_metadata)
    for issue in udp_issues:
        state(issue['pid'])
    event_keys = {(pid, event['_sequence']): event for pid, item in states.items() for event in item['events']}
    network_evidence = None
    object_evidence = None
    legacy_exempt = exempt
    exempt = set()
    if kernel_capture is not None:
        from uring.network import reconcile as reconcile_network
        eligible = {pid: count for pid, count in register_holes.items()
                    if pid not in invalid_terminal_stops and terminal_at.get(pid, 0) > terminal_stops[pid]}
        blocked_udp={issue['pid'] for issue in udp_issues if issue['reason'] in
                     ('udp_lifetime_unparsed_register','udp_duplicate_untracked_fd')}
        eligible={pid:count for pid,count in eligible.items() if pid not in blocked_udp}
        if classification_issues: eligible = {}
        blocked_metadata={issue['pid'] for issue in udp_issues} | {
            pid for pid,issues in ring_evidence['issuesByPid'].items() if issues}
        metadata_allowed={key for key,call in result_holes.items() if call=='close' and key[0] not in blocked_metadata}
        if classification_issues:metadata_allowed=set()
        network_evidence = reconcile_network(kernel_capture, udp_records, eligible, set(states), ring_evidence,
                                             {pid: tgid(pid) for pid in states},parents,
                                             {pid for pid,item in states.items() if item['finished']} if not classification_issues else set(),
                                             set(event_keys) | {(pid,seq) for pid,seq,call,connects in udp_writes if connects},
                                             metadata_allowed=metadata_allowed)
        from uring.socketObjects import reconcile as reconcile_objects
        connect_keys={key for key,event in event_keys.items() if event['syscall']=='connect'}
        proven_tcp={(operation['pid'],operation['sequence']) for operation in network_evidence['operationDiagnostics']
                    if operation['reconciled'] and set(operation['socketHooks']) & {'tcp_v4_connect','tcp_v6_connect'}}
        required_udp=udp_metadata['connectKeys'] | {(pid,seq) for pid,line,seq,*_ in udp_records
            if re.match(r'^connect\(\d+<UDP(?:v6)?:',line) and (pid,seq) in connect_keys}
        required_udp.difference_update(proven_tcp)
        object_evidence=reconcile_objects(kernel_capture,network_evidence,set(states),
                                          included if selected else set(states),connect_keys,required_udp)
        if object_evidence['verified']:
            # Complete object proof replaces only UDP descriptor inference.
            # Generic FD/io_uring, syscall decode and network checks remain.
            udp_issues=[]; udp_writes=[]
            from uring.network import CALLS
            seen_writes=set()
            for write in object_evidence['writes']:
                key=(write['pid'],write['sequence'])
                if write['sequence'] is not None and write['call'] in range(2,7) and key not in seen_writes:
                    seen_writes.add(key)
                    udp_writes.append((*key,CALLS[write['call']-1],write['connects']))
                elif write['sequence'] is None and write['layer']=='protocol' and any(
                        ring['creatorTgid']==tgid(write['pid']) for ring in ring_evidence['rings']):
                    issue={'pid':write['pid'],'reason':'udp_io_uring_write_fd_unproven'}
                    if issue not in udp_issues:udp_issues.append(issue)
            eligible={pid:count for pid,count in register_holes.items()
                      if pid not in invalid_terminal_stops and terminal_at.get(pid,0)>terminal_stops[pid]}
            blocked_metadata={pid for pid,issues in ring_evidence['issuesByPid'].items() if issues}
            metadata_allowed={key for key,call in result_holes.items() if call=='close' and key[0] not in blocked_metadata}
            if classification_issues:eligible={};metadata_allowed=set()
            network_evidence=reconcile_network(kernel_capture,udp_records,eligible,set(states),ring_evidence,
                {pid:tgid(pid) for pid in states},parents,
                {pid for pid,item in states.items() if item['finished']} if not classification_issues else set(),
                set(event_keys)|{(pid,seq) for pid,seq,call,connects in udp_writes if connects},
                metadata_allowed=metadata_allowed)
            object_evidence=reconcile_objects(kernel_capture,network_evidence,set(states),
                                              included if selected else set(states),connect_keys,required_udp)
            exempt=object_evidence['exempt']
        udp_issues.extend(object_evidence['issues'])
        if not kernel_capture.get('udpObjects'):
            udp_issues.extend({'pid':pid,'reason':'udp_socket_evidence_missing'} for pid in sorted({pid for pid,_ in legacy_exempt}))
        kernel_tcp={(operation['pid'],operation['sequence']) for operation in network_evidence['operationDiagnostics']
                    if set(operation['socketHooks']) & {'tcp_v4_connect','tcp_v6_connect'}}
        conflicts=exempt & kernel_tcp
        conflict_pids={pid for pid,_sequence in conflicts}
        for pid in sorted(conflict_pids):udp_issues.append({'pid':pid,'reason':'udp_kernel_tcp_connect_conflict'})
        exempt.difference_update(conflicts)
        network_evidence['metadataFields']=[item for item in network_evidence['metadataFields'] if item['pid'] not in conflict_pids]
        for evidence in network_evidence['resolved']:
            unparsed(evidence['pid'],'register_stub',-evidence['records'])
            evidence['straceRecordKinds']=terminal_shapes[evidence['pid']]
        for evidence in network_evidence['resultFields']:
            key=(evidence['pid'],evidence['sequence'])
            if key in result_holes:
                unparsed(evidence['pid'],'result',-1,result_holes[key])
        for evidence in network_evidence['metadataFields']:
            unparsed(evidence['pid'],'result',-1,'close')

    elif legacy_exempt:
        udp_issues.extend({'pid':pid,'reason':'udp_socket_evidence_missing'} for pid in sorted({pid for pid,_ in legacy_exempt}))
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

    raw_records={(pid,seq):line for pid,line,seq,*_ in udp_records}
    operation_diagnostics={(item['pid'],item['sequence']):item for item in
                           (network_evidence or {}).get('operationDiagnostics',[])}
    def descriptor_diagnostic(key):
        match=re.match(r'^\w+\(\s*(-?\d+)(?:<([^>]*)>)?',raw_records.get(key,''))
        label=match[2] if match and match[2] else ''
        kind=('tcp' if label.startswith(('TCP:','TCPv6:')) else
              'udp' if label.startswith(('UDP:','UDPv6:')) else
              'unix' if label.startswith('UNIX') else 'netlink' if label.startswith('NETLINK') else
              'file' if label.startswith('/') else 'other')
        return {'pid':key[0],'sequence':key[1],'fd':int(match[1]) if match else None,
                'straceSocketKind':kind,'kernel':operation_diagnostics.get(key)}

    def report(pids, scope):
        events = [event for pid in pids for event in states[pid]['events']]
        external = [event for event in events if event['external']]
        processes = []
        issues = classification_issues + [issue for issue in udp_issues if issue.get('pid') is None or issue['pid'] in pids] + ([issue for pid in pids for issue in ring_evidence['issuesByPid'].get(pid,[])]
            if ring_evidence is not None else [
                {'reason': 'unsupported_io_uring', 'pid': pid, 'syscall': call}
                for pid in sorted(pids) for call in states[pid]['io_uring']])
        issues += [{'reason':'unsupported_external_accept','pid':pid} for pid in pids
                   for _ in range(states[pid]['external_accepts'])]
        if network_evidence is not None:
            issues = [dict(issue) for issue in issues]
            for issue in network_evidence['issues']:
                if issue.get('pid') is not None and issue['pid'] not in pids: continue
                # Preserve existing control counts while retaining every new
                # cause on the already-fatal per-task classification. This
                # never makes evidence eligible for register-hole resolution.
                existing = next((entry for entry in issues if issue.get('pid') is not None and
                    entry.get('pid') == issue['pid'] and entry['reason'] in
                    ('udp_io_uring_write_fd_unproven', 'io_uring_opcode_not_allowed')), None)
                if existing is not None:
                    existing.setdefault('kernelCorroboration', []).append(issue)
                else: issues.append(issue)
        resolutions = [evidence for evidence in (network_evidence or {}).get('resolved', []) if evidence['pid'] in pids]
        nonexecution = [evidence for evidence in (network_evidence or {}).get('notExecuted', []) if evidence['pid'] in pids]
        nonnetwork=[evidence for evidence in (network_evidence or {}).get('nonNetworkWrites',[]) if evidence['pid'] in pids]
        result_fields=[evidence for evidence in (network_evidence or {}).get('resultFields',[]) if evidence['pid'] in pids]
        metadata_fields=[evidence for evidence in (network_evidence or {}).get('metadataFields',[]) if evidence['pid'] in pids]
        external_diagnostics=[]
        for key,event in event_keys.items():
            if key[0] in pids and event['external']:
                external_diagnostics.append({**descriptor_diagnostic(key),'syscall':event['syscall'],
                    'udpWriteAssociations':[{**descriptor_diagnostic((pid,seq)),'syscall':call}
                        for pid,seq,call,connects in udp_writes if key in connects]})
        for pid in sorted(pids):
            item = states[pid]
            processes.append({'pid': pid, 'parentPid': parents.get(pid), 'process': item['process'],
                              'inScope': not selected or pid in included, 'root': pid in roots, 'finished': item['finished'],
                              'destinationAttempts': len(item['events']),
                              'externalAttempts': sum(event['external'] for event in item['events']),
                              'ioUringSyscalls': item['io_uring'],
                              'unparsedRecords': item['unparsed'],
                              'unparsedRecordKinds':dict(sorted(item['unparsed_kinds'].items()))})
        return {'schema': 'aelix-studio-host.outbound-audit/1', 'scope': scope,
                'traceFiles': len(paths), 'processCount': len(pids), 'rootPids': sorted(roots),
                'rootExecutables': [{'pid': pid, 'executable': root_executables[pid]} for pid in sorted(roots)],
                'destinationAttempts': len(events), 'externalAttempts': len(external),
                'udpConnectOnly': sum(event['udpAssociationOnly'] for event in events),
                'udpAssociations': [event for event in events if event['udpAssociationOnly']],
                'udpSocketObjects': ({'verified':object_evidence['verified'],
                    'objects':[obj for obj in object_evidence['objects'] if set(obj['actorPids']) & pids],
                    'probes':kernel_capture.get('udpObjectProbes'),
                    'signatureSha256':kernel_capture.get('udpObjectSignatureSha256'),
                    'lossChecks':kernel_capture.get('udpProbeLoss'),
                    'typedProbeDefinitions':kernel_capture.get('udpTypedProbeDefinitions'),
                    'rawTracepointSignatures':kernel_capture.get('rawTracepointSignatures'),
                    'rcuOffset':kernel_capture.get('udpSocketRcuOffset')}
                    if object_evidence is not None else {'verified':False}),
                'unparsedRecords': sum(states[pid]['unparsed'] for pid in pids) + len(issues),
                'classificationErrors': len(issues), 'classificationIssues': issues,
                'kernelResolvedRecords': sum(evidence['records'] for evidence in resolutions),
                'kernelResolutions': resolutions,
                'kernelNotExecutedInvocations': len(nonexecution),
                'kernelNotExecuted': nonexecution,
                'kernelNonNetworkWriteInvocations':len(nonnetwork),
                'kernelNonNetworkWrites':nonnetwork,
                'kernelResolvedResultFields':len(result_fields),
                'kernelResultFields':result_fields,
                'kernelMetadataResolvedRecords':sum(evidence['records'] for evidence in metadata_fields),
                'kernelMetadataResolutions':metadata_fields,
                'externalOperationDiagnostics':external_diagnostics,
                'kernelNetwork': ({'recorded': kernel_capture.get('complete', False),
                    'eventCount': network_evidence['eventCount'],
                    'preEntrySignatureSha256': kernel_capture.get('preEntrySignatureSha256'),
                    'preEntryProbe': kernel_capture.get('preEntryProbe'),
                    'kernelBtfSha256': kernel_capture.get('kernelBtfSha256'),
                    'socketSymbols': kernel_capture.get('socketSymbols'),
                    'socketSignatureSha256': kernel_capture.get('socketSignatureSha256'),
                    'socketFamilySource': 'socket',
                    'socketFamilyField': 'socket.sk.__sk_common.skc_family',
                    'workerSignatureSha256': kernel_capture.get('workerSignatureSha256'),
                    'taskExitProbe':kernel_capture.get('taskExitProbe'),
                    'attachmentReadiness':kernel_capture.get('attachmentReadiness'),
                    'socketProbes': kernel_capture.get('socketProbes', []),
                    'fileWriteProbes': kernel_capture.get('fileWriteProbes', [])}
                    if network_evidence is not None else {'recorded': False}),
                'external': external, 'processes': processes,
                'ioUring': ({'recorded':kernel_capture.get('complete',False),'opcodeCounts':ring_evidence['selectedOpcodeCounts'] if scope=='selected-process-trees' else ring_evidence['opcodeCounts'],
                             'policy':'node-v24.11.0-libuv-explicit-file-and-epoll',
                             'capture':{k:kernel_capture.get(k) for k in ('complete','drained','drainState','programLoss','lostEvents','eventCount','namespaceInode','pidNamespaceVerified','root','kernelCounts','recordErrors','recorderExitCode','tool','toolVersion','kernel','tracepoints','formatSha256','programSha256','pidNumbersOffset','reason','diagnostics')},
                             'rings':[r for r in ring_evidence['rings'] if r['creatorPid'] in pids]}
                            if ring_evidence is not None else {'recorded':False})}

    whole = report(set(states), 'all')
    scoped = report(set(states) & included, 'selected-process-trees') if selected else whole
    return scoped, whole
