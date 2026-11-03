"""Parse buffer-suppressed strace records and select complete descendant trees.

Executable paths are used privately to identify roots. Reports contain PID/comm
and network metadata, never argv, environment, payloads or executable paths.
"""
import ipaddress
from pathlib import Path, PurePosixPath
import re

NETWORK = {'connect', 'sendto', 'sendmsg', 'sendmmsg'}
FORK = {'clone', 'clone3', 'fork', 'vfork'}
EXEC = {'execve', 'execveat'}
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


def analyze_processes(paths, scope_executables=(), require_executables=(), require_lifecycle=False):
    """Scope by successful exec roots plus all forks/threads, never by address/name."""
    selected = {canonical(path) for path in scope_executables}
    required = {canonical(path) for path in require_executables}
    states, parents, roots, matches = {}, {}, set(), set()
    root_executables = {}
    fork_at, executions = {}, {}
    sequence = 0
    structural_errors = 0
    observed_order = []
    pending = {}

    def state(pid, name=None):
        if pid not in states:
            states[pid] = {'pid': pid, 'process': 'unknown', 'events': [], 'unparsed': 0, 'finished': False}
            observed_order.append(pid)
        if name and re.fullmatch(r'[A-Za-z0-9_.+ -]{1,64}', name):
            states[pid]['process'] = name
        return states[pid]

    def unknown(pid, call):
        nonlocal structural_errors
        if call in NETWORK:
            state(pid)['unparsed'] += 1
        else:
            structural_errors += 1

    def record(pid, line, started):
        nonlocal structural_errors
        item = state(pid)
        if line.startswith('+++'):
            if re.match(r'^\+\+\+ (?:exited with |killed by |superseded by execve in pid )', line):
                item['finished'] = True
            else:
                structural_errors += 1
            return
        match = CALL.match(line)
        if not match:
            if line and not line.startswith(('+++', '---')):
                structural_errors += 1
            return
        call = match[1]
        if call in FORK:
            result = re.search(r'\)\s+=\s+(-?\d+)(?:<[^>]*>)?(.*)$', line)
            if not result:
                structural_errors += 1; return
            child = int(result[1])
            translated = re.search(r"/\* (\d+) in strace's PID NS \*/", result[2])
            if child > 0 and translated:
                child = int(translated[1])
            if child > 0:
                if child == pid or child in parents:
                    structural_errors += 1
                else:
                    parents[child] = pid
                    fork_at[child] = started
            return
        if call in EXEC:
            if not re.search(r'=\s+0(?:\s|$)', line):
                if '= -1 ' not in line: structural_errors += 1
                return
            pattern = rf'^execve\(({QUOTED}),' if call == 'execve' else rf'^execveat\([^,]+, ({QUOTED}),'
            filename = re.match(pattern, line)
            if not filename:
                structural_errors += 1; return
            try:
                executable = decode_path(filename[1])
                # Trace filenames always follow Linux/POSIX rules, including offline tests on Windows.
                if not PurePosixPath(executable).is_absolute():
                    if selected: structural_errors += 1
                    return
            except (OSError, ValueError, RuntimeError):
                structural_errors += 1; return
            executions.setdefault(pid, []).append((started, executable))
            return
        if call not in NETWORK:
            structural_errors += 1; return
        def destination(address, port):
            try:
                parsed = ipaddress.ip_address(address.strip('[]'))
                port = int(port)
                if not 0 <= port <= 65535: raise ValueError('Invalid port')
            except ValueError:
                item['unparsed'] += 1; return
            effective = parsed.ipv4_mapped if isinstance(parsed, ipaddress.IPv6Address) else None
            local = (effective or parsed).is_loopback and port != 53
            item['events'].append({'pid': pid, 'process': item['process'], 'syscall': call,
                                   'address': str(parsed), 'port': port, 'external': not local,
                                   'failed': bool(re.search(r'= -1\b', line))})

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
        # A selected child can inherit an already-connected socket from an
        # unselected parent. Decode the peer at send time; its connect need not
        # have happened inside the selected tree. -yy provides kernel FD peers.
        null_count = (1 if call == 'sendto' and re.search(r', NULL, 0\)\s+=', line) else
                      len(re.findall(r'msg_name=NULL', line)) if call in ('sendmsg', 'sendmmsg') else 0)
        if call == 'sendmmsg' and 'msg_name=' not in line:
            item['unparsed'] += 1
        if null_count:
            fd = re.match(r'^\w+\(\d+<(.+?)>,', line)
            peer = fd[1] if fd else ''
            if peer.startswith(('UNIX', 'NETLINK')):
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
                if selected and line: structural_errors += 1
            state(pid, name)
            call = CALL.match(line)
            resumed = RESUMED.match(line)
            if '<unfinished ...>' in line:
                if pid in pending:
                    unknown(pid, pending[pid][0])
                if not call:
                    structural_errors += 1; continue
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
                if selected: structural_errors += 1
            elif executable in selected:
                roots.add(pid); matches.add(executable)
                root_executables[pid] = Path(executable).name

    if require_lifecycle:
        structural_errors += sum(not item['finished'] for item in states.values())
    if (selected or require_lifecycle) and states:
        # The traced command is the only permitted parentless task. Every other
        # PID/TID must have a captured fork edge, including reparented descendants.
        structural_errors += sum(pid not in parents for pid in states if pid != observed_order[0])
        if selected and not roots: structural_errors += 1
        structural_errors += sum(child not in states for child in parents)
        structural_errors += len(required - matches)
        for child in parents:
            seen = set()
            current = child
            while current in parents:
                if current in seen:
                    structural_errors += 1; break
                seen.add(current); current = parents[current]
    included = set(roots)
    while selected:
        more = {child for child, parent in parents.items() if parent in included} - included
        if not more: break
        included.update(more)

    def report(pids, scope):
        events = [event for pid in pids for event in states[pid]['events']]
        external = [event for event in events if event['external']]
        processes = []
        for pid in sorted(pids):
            item = states[pid]
            processes.append({'pid': pid, 'parentPid': parents.get(pid), 'process': item['process'],
                              'inScope': not selected or pid in included, 'root': pid in roots, 'finished': item['finished'],
                              'destinationAttempts': len(item['events']),
                              'externalAttempts': sum(event['external'] for event in item['events']),
                              'unparsedRecords': item['unparsed']})
        return {'schema': 'aelix-studio-host.outbound-audit/1', 'scope': scope,
                'traceFiles': len(paths), 'processCount': len(pids), 'rootPids': sorted(roots),
                'rootExecutables': [{'pid': pid, 'executable': root_executables[pid]} for pid in sorted(roots)],
                'destinationAttempts': len(events), 'externalAttempts': len(external),
                'unparsedRecords': sum(states[pid]['unparsed'] for pid in pids) + structural_errors,
                'classificationErrors': structural_errors, 'external': external, 'processes': processes}

    whole = report(set(states), 'all')
    scoped = report(set(states) & included, 'selected-process-trees') if selected else whole
    return scoped, whole
