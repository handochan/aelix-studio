"""Linux OS-level outbound-attempt audit for a command and all its descendants.

Counts attempted connect/sendto/sendmsg/sendmmsg destinations, including failed
syscalls, from exec through final child exit. Unix/kernel IPC and loopback are
allowed; DNS port 53 is denied even on loopback (a local resolver may forward it).
Raw traces use -s 0 and are deleted; reports contain PID/comm and network metadata, no payloads.
Optional executable roots select descendant trees; the default remains whole-command enforcement.
Exit 86 means detected outbound attempts; 87 means incomplete/unparseable evidence.
"""
import argparse
import contextlib
import ctypes
import hashlib
import json
import math
import os
import signal
import re
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from outboundScope import analyze_processes, measure_processes
from uring.capture import Capture, diagnostic_task_snapshot, read_task_recording
from uring.policy import ALLOWED_OPCODES

DENIED = 86
INCOMPLETE = 87


def analyze(paths):
    """Legacy whole-command parser entry point, retained for existing callers."""
    return analyze_processes(paths)[0]


def npm_config_paths():
    """Inspect launch-time config without invoking npm outside the syscall trace."""
    env = {key.lower(): value for key, value in os.environ.items()}
    paths = [directory / '.npmrc' for directory in (Path.cwd(), *Path.cwd().parents)]
    paths.extend([Path.home() / '.npmrc', Path('/etc/npmrc'), Path('/usr/local/etc/npmrc')])
    for key in ('npm_config_userconfig', 'npm_config_globalconfig'):
        if env.get(key):
            paths.append(Path(os.path.expandvars(env[key])).expanduser())
    if env.get('npm_config_prefix'):
        paths.append(Path(os.path.expandvars(env['npm_config_prefix'])).expanduser() / 'etc/npmrc')
    for tool in ('node', 'npm'):
        executable = shutil.which(tool)
        if executable:
            paths.append(Path(executable).resolve().parent.parent / 'etc/npmrc')
    return paths


def npm_proxy_configured(paths):
    seen = set()
    while paths:
        path = paths.pop().absolute()
        if path in seen:
            continue
        seen.add(path)
        try:
            text = path.read_text()
        except FileNotFoundError:
            continue
        for line in text.splitlines():
            if not line.strip() or line.lstrip().startswith(('#', ';')) or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip().lower().replace('_', '-')
            value = value.strip().strip('\"\'')
            if key in ('proxy', 'https-proxy') and value:
                return True
            if key in ('userconfig', 'globalconfig', 'prefix') and value:
                nested = Path(os.path.expandvars(value)).expanduser()
                paths.append(nested / 'etc/npmrc' if key == 'prefix' else nested)
    return False


def resolve_strace(root=None):
    """Use the same prepared binary even across sudo's secure_path boundary."""
    root = Path(root) if root is not None else Path(__file__).resolve().parents[3]
    pinned = root / '.local/strace-toolchain/bin/strace'
    return str(pinned) if pinned.is_file() else shutil.which('strace')


def unsupported_personalities(stderr):
    return len(re.findall(r'Proper structure decoding for this\s+personality is not supported', stderr, re.I))



# Only known recording gaps may replay an isolated command. An unlisted reason,
# including any undecodable network destination/peer, remains a first-pass failure.
RECAPTURE_ISSUES = frozenset({'unknown_record', 'kernel_network_strace_entry_missing',
    'io_uring_kernel_capture_incomplete', 'kernel_network_capture_incomplete', 'udp_socket_capture_incomplete'})
RECAPTURE_KERNEL_LOSSES = frozenset({'kernel_bpf_program_recursion_lost'})
RECAPTURE_RECORD_KINDS = frozenset({'register_stub'})
CAPTURE_TIMEOUT = 480
CAPTURE_CLEANUP = 75
SUPERVISOR_CLEANUP = 15
FORCE_CLEANUP = 5
REPORT_HISTORY_RESERVE = 30
TASK_EVIDENCE_INPUT_TIMEOUT = 1
TASK_EVIDENCE_COLLECTION_TIMEOUT = 30
TASK_EVIDENCE_WRITE_TIMEOUT = 10
TASK_EVIDENCE_EXIT_RESERVE = 1
SUPERVISOR_DEADLINE_ENV = 'AELIX_OUTBOUND_SUPERVISOR_DEADLINE'

OWNED_SIGNAL = "import os, sys\nfrom pathlib import Path\ntry:\n    fields = (Path('/proc') / sys.argv[1] / 'stat').read_text().rsplit(')', 1)[1].split()\n    if fields[19] == sys.argv[2]:\n        os.kill(int(sys.argv[1]), int(sys.argv[3]))\nexcept (FileNotFoundError, ProcessLookupError):\n    pass\n"


def recapture_reasons_allowed(report):
    if report.get('observedRejectedOpcodes'): return False
    issues = report.get('classificationIssues', [])
    if any(item.get('reason') not in RECAPTURE_ISSUES for item in issues): return False
    kinds = [p.get('unparsedRecordKinds', {}) for p in report.get('processes', [])]
    if any(key not in RECAPTURE_RECORD_KINDS for counts in kinds for key in counts): return False
    if any(p.get('unparsedRecords', 0) != sum(p.get('unparsedRecordKinds', {}).values())
           for p in report.get('processes', [])): return False
    if report.get('unparsedRecords') != len(issues) + sum(sum(counts.values()) for counts in kinds): return False
    capture = report.get('ioUring', {}).get('capture', {})
    incomplete_kernel = any(i['reason'] in RECAPTURE_ISSUES - {'unknown_record', 'kernel_network_strace_entry_missing'} for i in issues)
    if incomplete_kernel or capture and not capture.get('complete'):
        # Missing kernel proof cannot validate a simultaneous strace hole.
        if any(kinds) or any(i['reason'] in ('unknown_record', 'kernel_network_strace_entry_missing') for i in issues): return False
        if capture.get('reason') not in RECAPTURE_KERNEL_LOSSES or not capture.get('pidNamespaceVerified'): return False
        if capture.get('diagnostics'): return False
        counters = capture.get('kernelCounts') or {}
        if any(counters.get(key, 0) for key in ('namespace_error', 'unsupported_abi', 'pre_mismatch',
               'network_return_id_error', 'raw_state_overlap', 'pre_layout_error', 'socket_layout_error',
               'worker_error', 'udp_object_error', 'untracked_sqpoll', 'unmatched_completion')): return False
    if any(not isinstance(item, dict) or item.get('reason') not in RECAPTURE_KERNEL_LOSSES
           for item in capture.get('recordErrors', [])): return False
    return bool(issues or any(kinds))


def should_recapture(report):
    diagnostics = report.get('externalOperationDiagnostics', [])
    # Only unresolved, unsent UDP associations can be provisional counts.
    # A real TCP connect/send/write observed alongside a capture hole must
    # never be erased by a quieter second execution. Missing diagnostics
    # are also conservative failure evidence, not permission to replay.
    provisional = len(diagnostics) == report.get('externalAttempts', 0) and all(
        item.get('syscall') == 'connect' and item.get('straceSocketKind') == 'udp' and
        not item.get('udpWriteAssociations') and not
        (set((item.get('kernel') or {}).get('socketHooks', [])) & {'tcp_v4_connect', 'tcp_v6_connect'})
        for item in diagnostics)
    command_failed = report.get('commandStarted') and report.get('commandExitCode') != 0
    return (report.get('outcome') == 'evidence_incomplete' and provisional and
            recapture_reasons_allowed(report) and not command_failed)


def process_table():
    """Linux PID/parent/start-tick identities, without argv or environment."""
    result = {}
    for path in Path('/proc').glob('[0-9]*/stat'):
        try:
            fields = path.read_text().rsplit(')', 1)[1].split()
            result[int(path.parent.name)] = (int(fields[1]), fields[19], fields[0])
        except (OSError, ValueError, IndexError): continue
    return result


def stop_owned_tree(root, *, include_root=False, grace=None, root_birth=None):
    """Terminate only live descendants with revalidated PID birth identities."""
    if root_birth is None and root == os.getpid():
        root_birth = process_table()[root][1]
    if root_birth is None: raise RuntimeError('owned_root_identity_missing')
    known = {}
    empty_rounds = root_only_rounds = 0
    deadline = time.monotonic() + (SUPERVISOR_CLEANUP if grace is None else grace)
    hard_deadline = deadline + FORCE_CLEANUP
    while True:
        table = process_table()
        current_root = table.get(root)
        owned = {root} if current_root and current_root[1] == root_birth else set()
        while True:
            added = {pid for pid, (parent, _, _) in table.items() if parent in owned} - owned
            if not added: break
            owned.update(added)
        if not include_root: owned.discard(root)
        for pid in owned:
            if pid in table: known.setdefault(pid, table[pid][1])
        live = {pid for pid, birth in known.items() if pid in table and table[pid][1] == birth and table[pid][2] != 'Z'}
        if not live:
            empty_rounds += 1
            if empty_rounds >= 2: return
            time.sleep(0.05)
            continue
        empty_rounds = 0
        descendants = live - {root}
        root_only_rounds = root_only_rounds + 1 if not descendants else 0
        force = time.monotonic() >= deadline
        for pid in sorted(live, reverse=True):
            # Preserve the subreaper until descendants are absent in two fresh
            # snapshots. A force round must never kill root alongside children.
            if pid == root and (descendants or root_only_rounds < 2): continue
            current = process_table().get(pid)
            if not current or current[1] != known[pid]: continue
            selected = signal.SIGKILL if force else signal.SIGTERM
            try:
                os.kill(pid, selected)
                if not force: os.kill(pid, signal.SIGCONT)
            except ProcessLookupError: pass
            except PermissionError:
                # Only a revalidated owned sudo/BPF descendant can reach here.
                subprocess.run(['sudo', '-n', sys.executable, '-I', '-B', '-c', OWNED_SIGNAL,
                                str(pid), known[pid], str(int(selected))],
                               check=True, capture_output=True, timeout=5)
        # Keep the subreaper/root alive and rescan after KILL too: a process
        # can fork during shutdown and leave a newly adopted descendant.
        if force and time.monotonic() >= hard_deadline:
            raise RuntimeError('owned_process_tree_cleanup_incomplete')
        time.sleep(0.05)


def read_supervisor_deadline(value):
    """An absent limit is unbounded. An invalid hint disables task evidence."""
    if value is None:
        return math.inf
    try:
        deadline = float(value)
    except ValueError:
        return 0.0
    return 0.0 if math.isnan(deadline) else deadline


def supervise(command, timeout):
    """Subreap detached tracer/app descendants before returning to acceptance."""
    if sys.platform != 'linux': raise RuntimeError('Linux supervision required')
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('audit_subreaper_unavailable')
    interrupted = []
    def cancel(signum, _frame): interrupted.append(signum)
    for signum in (signal.SIGTERM, signal.SIGINT): signal.signal(signum, cancel)
    # The child uses this conservative cutoff only for optional evidence. The
    # actual supervision timeout still starts after the child is launched.
    env = os.environ.copy()
    env[SUPERVISOR_DEADLINE_ENV] = str(min(time.monotonic() + timeout,
                                           read_supervisor_deadline(env.get(SUPERVISOR_DEADLINE_ENV))))
    child = subprocess.Popen(command, env=env)
    deadline = time.monotonic() + timeout
    timed_out = False
    try:
        while child.poll() is None:
            if interrupted or time.monotonic() >= deadline:
                timed_out = True
                child.terminate()
                try: child.wait(timeout=CAPTURE_CLEANUP)
                except subprocess.TimeoutExpired: pass
                break
            time.sleep(0.02)
    finally:
        stop_owned_tree(os.getpid())
        child.wait(timeout=5)
        # Reap adopted zombies after all live descendants have been stopped.
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0: break
            except ChildProcessError: break
    return 124 if timed_out else child.returncode


def run_supervised(command, *, timeout, **options):
    """Keep the subreaper alive until timeout cleanup has covered detached trees."""
    if options.pop('capture_output', False):
        options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    supervised = [sys.executable, '-I', '-B', str(Path(__file__).resolve()),
                  '--supervise', str(timeout), '--', *map(str, command)]
    process = subprocess.Popen(supervised, start_new_session=True, **options)
    root_birth = (process_table().get(process.pid) or (None, None))[1]
    try:
        stdout, stderr = process.communicate(timeout=timeout + CAPTURE_CLEANUP + SUPERVISOR_CLEANUP + FORCE_CLEANUP + 10)
    except BaseException:
        # Do not kill the subreaper before enumerating its adopted descendants.
        stop_owned_tree(process.pid, include_root=True, root_birth=root_birth)
        process.communicate(timeout=5)
        raise
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


class CaptureInterrupted(RuntimeError):
    pass


@contextlib.contextmanager
def capture_deadline(seconds, *, handle_sigterm=True, timeout_error=CaptureInterrupted):
    def timeout(_signum, _frame): raise timeout_error('capture_timeout')
    def cancel(_signum, _frame): raise CaptureInterrupted('capture_cancelled')
    old_alarm = signal.signal(signal.SIGALRM, timeout)
    old_term = signal.signal(signal.SIGTERM, cancel) if handle_sigterm else None
    old_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try: yield time.monotonic() + seconds
    finally:
        signal.setitimer(signal.ITIMER_REAL, *old_timer)
        signal.signal(signal.SIGALRM, old_alarm)
        if handle_sigterm: signal.signal(signal.SIGTERM, old_term)


def task_evidence_fits(deadline, *, reserve=0):
    return deadline - time.monotonic() >= TASK_EVIDENCE_COLLECTION_TIMEOUT + TASK_EVIDENCE_WRITE_TIMEOUT + reserve


def attach_task_evidence(collect, scoped_paths, whole_paths, *, deadline):
    """Enrich saved verdicts within separate collection and storage budgets."""
    if not task_evidence_fits(deadline):
        return
    try:
        with capture_deadline(TASK_EVIDENCE_COLLECTION_TIMEOUT, handle_sigterm=False):
            scoped, whole = collect()
    except Exception:
        print('Task evidence unavailable: collection failed or exceeded its budget', file=sys.stderr)
        return

    write_timeout = min(TASK_EVIDENCE_WRITE_TIMEOUT, deadline - time.monotonic())
    if write_timeout <= 0:
        return
    try:
        with capture_deadline(write_timeout, handle_sigterm=False):
            for paths, evidence in ((scoped_paths, scoped), (whole_paths, whole)):
                for path in paths:
                    path = path.resolve()
                    report = json.loads(path.read_text())
                    report.update(taskEvidence=evidence, taskEvidenceStatus='available')
                    # A short write or timeout must leave the verdict and its
                    # unavailable marker intact at the original report path.
                    with tempfile.TemporaryDirectory(dir=path.parent, prefix='.task-evidence-') as directory:
                        pending = Path(directory) / path.name
                        pending.write_text(json.dumps(report, indent=2) + '\n')
                        pending.chmod(stat.S_IMODE(path.stat().st_mode))
                        pending.replace(path)
    except Exception:
        print('Task evidence unavailable on remaining reports: storage failed or exceeded its budget', file=sys.stderr)


def audit(command, report_path, *, scope_executables=(), require_executables=(), whole_report_path=None,
          recapture=True, capture_timeout=CAPTURE_TIMEOUT, task_evidence_deadline=None):
    """Recapture incomplete evidence once; never retry a functional/policy failure.

    Commands must own fresh state per invocation (the installer drivers use
    TemporaryDirectory). Both measurements survive, including provisional counts.
    """
    inherited_hint = os.environ.get(SUPERVISOR_DEADLINE_ENV)
    inherited_deadline = read_supervisor_deadline(inherited_hint)
    evidence_deadline = min(inherited_deadline, read_supervisor_deadline(task_evidence_deadline)) - TASK_EVIDENCE_EXIT_RESERVE

    def terminate(signum, _frame):
        # Let capture files and any partial diagnostic write unwind on TERM.
        signal.signal(signum, signal.SIG_IGN)
        raise SystemExit(128 + signum)

    attempts = []
    with contextlib.ExitStack() as cleanup:
        previous_term = signal.signal(signal.SIGTERM, terminate)
        cleanup.callback(signal.signal, signal.SIGTERM, previous_term)
        if inherited_hint is not None:
            # Keep the supervisor's budget private to the auditor.
            cleanup.callback(os.environ.__setitem__, SUPERVISOR_DEADLINE_ENV, inherited_hint)
            del os.environ[SUPERVISOR_DEADLINE_ENV]
        for attempt in (1, 2):
            if attempt == 2:
                report.update(recaptures=1, captureAttempts=[*attempts, {'attempt': 2, 'status': 'running'}])
                report_path.write_text(json.dumps(report, indent=2) + '\n')
            code, collect, replay = capture_once(command, report_path, scope_executables=scope_executables,
                require_executables=require_executables, whole_report_path=whole_report_path,
                capture_timeout=capture_timeout, allow_recapture=attempt == 1 and recapture,
                evidence_deadline=evidence_deadline)
            report = json.loads(report_path.read_text())
            snapshot = report_path.with_name(report_path.stem + f'.capture-{attempt}' + report_path.suffix)
            snapshot.write_text(json.dumps(report, indent=2) + '\n')
            attempts.append(dict(attempt=attempt, report=snapshot.name, exitCode=code,
                                 outcome=report.get('outcome', report.get('reason')),
                                 externalAttempts=report.get('externalAttempts'),
                                 unparsedRecords=report.get('unparsedRecords')))
            whole_paths = ()
            if whole_report_path is not None and whole_report_path.exists():
                whole_snapshot = whole_report_path.with_name(whole_report_path.stem + f'.capture-{attempt}' + whole_report_path.suffix)
                whole_snapshot.write_bytes(whole_report_path.read_bytes())
                whole_paths = (whole_snapshot, whole_report_path)
            report['captureAttempts'] = list(attempts)
            report['recaptures'] = len(attempts) - 1
            report_path.write_text(json.dumps(report, indent=2) + '\n')
            if not replay:
                break
            print('::warning title=Outbound audit recapture::Incomplete evidence; recapturing once; first report '+snapshot.name, flush=True)
        if collect is not None:
            attach_task_evidence(collect, (snapshot, report_path), whole_paths, deadline=evidence_deadline)
    return code


def capture_once(command, report_path, *, scope_executables=(), require_executables=(), whole_report_path=None,
                 capture_timeout=CAPTURE_TIMEOUT, allow_recapture=False, evidence_deadline=math.inf):
    with contextlib.ExitStack() as raw_capture:
        # Required analysis, hashing and report writing keep the capture budget.
        try:
            with capture_deadline(capture_timeout) as deadline:
                return _capture_once(command, report_path, raw_capture,
                    scope_executables=scope_executables, require_executables=require_executables,
                    whole_report_path=whole_report_path, capture_timeout=capture_timeout, activity_deadline=deadline,
                    allow_recapture=allow_recapture, evidence_deadline=evidence_deadline)
        except CaptureInterrupted as error:
            # No analysis budget remains. Unknown counts are not a zero receipt.
            raw_capture.close()
            report = dict(schema='aelix-studio-host.outbound-audit/1', status='failed',
                outcome=str(error), reason=str(error), evidenceComplete=False,
                scope='selected-process-trees' if scope_executables else 'all', enforcement='blocking',
                traceFiles=0, processCount=0, rootPids=[], processes=[], external=[], externalAttempts=None,
                unparsedRecords=1, classificationErrors=1, classificationIssues=[{'reason':str(error)}],
                commandStarted=None, commandExitCode=None, captureTimeoutSeconds=capture_timeout,
                ioUring=dict(recorded=False, opcodeCounts={},capture=dict(complete=False,reason=str(error))))
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, indent=2)+'\n')
            if whole_report_path is not None:
                whole_report_path.parent.mkdir(parents=True, exist_ok=True)
                whole_report_path.write_text(json.dumps(dict(report,scope='all',enforcement='report-only',status='reported'),indent=2)+'\n')
            print('Capture failed within its original bound: '+str(error), file=sys.stderr)
            return INCOMPLETE, None, False


def _capture_once(command, report_path, raw_capture, *, scope_executables=(), require_executables=(), whole_report_path=None,
                  capture_timeout=CAPTURE_TIMEOUT, activity_deadline=None, allow_recapture=False, evidence_deadline=math.inf):
    activity_deadline = activity_deadline or time.monotonic() + capture_timeout
    proxy_keys = [key for key, value in os.environ.items() if value.strip() and key.lower().replace('-', '_') in ('http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy')]
    if proxy_keys:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps({'schema': 'aelix-studio-host.outbound-audit/1', 'status': 'failed', 'reason': 'proxy_environment', 'proxyKeys': proxy_keys}) + '\n')
        print('Audit refused: proxy environment may hide destination attempts', file=sys.stderr)
        return INCOMPLETE, None, False
    try:
        npm_proxy = npm_proxy_configured(npm_config_paths())
    except (OSError, UnicodeError):
        npm_proxy = None
    if npm_proxy is not False:
        reason = 'npm_proxy_configuration' if npm_proxy else 'npm_configuration_unreadable'
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps({'schema': 'aelix-studio-host.outbound-audit/1', 'status': 'failed', 'reason': reason}) + '\n')
        print('Audit refused: npm configuration may hide destination attempts', file=sys.stderr)
        return INCOMPLETE, None, False
    tracer = resolve_strace()
    if sys.platform != 'linux' or tracer is None:
        raise RuntimeError('Linux strace is required; audit cannot be skipped')
    directory = raw_capture.enter_context(tempfile.TemporaryDirectory(prefix='host-outbound-audit-'))
    prefix = Path(directory) / 'network'
    # -f follows forks/threads; PID namespace translation keeps all edges in
    # the tracer namespace (Chromium sandboxes can return local PIDs).
    # With -s 0 (and default abbreviation), execve records only its filename:
    # argv is [...] and env is a pointer/count. Tests assert sentinel absence.
    # Only sendmmsg's destination vector is unabbreviated; data stays hidden.
    # -yy exposes connected FD peers, including sockets inherited at exec.
    # -q retains terminal records, so missing/detached tasks cannot look complete.
    # Raw traces are removed and executable paths never enter JSON reports.
    trace = prefix.with_suffix('.trace')
    trace_command = [tracer, '-f', '--decode-pids=comm,pidns', '-yy', '-q', '-s', '0', '-e', 'abbrev=!sendmmsg', '-e',
                              'trace=socket,unshare,connect,sendto,sendmsg,sendmmsg,write,writev,accept,accept4,io_uring_setup,io_uring_enter,io_uring_register,close,close_range,mmap,dup,dup2,dup3,fcntl,clone,clone3,fork,vfork,execve,execveat',
                              '-o', str(trace), '--', *command]
    marker=Path(directory)/'stopped.json'
    capture=Capture(Path(directory))
    stderr_path=Path(directory)/'command.stderr'
    stderr_stream=stderr_path.open('wb')
    process=subprocess.Popen([sys.executable,'-I','-B',str(Path(__file__).with_name('uring')/'capture.py'),
                              '--exec-stop',str(marker),'--',*trace_command],start_new_session=True,stderr=stderr_stream)
    root_birth = (process_table().get(process.pid) or (None, None))[1]
    command_started = False
    try:
        capture.start(process.pid)
        if not marker.exists():raise RuntimeError('audit_root_stop_marker_missing')
        os.kill(process.pid,signal.SIGCONT)
        command_started = True
        process.wait()
        evidence=capture.stop()
    except (OSError,RuntimeError,ValueError,subprocess.SubprocessError) as error:
        remaining = max(0, activity_deadline - time.monotonic())
        signal.setitimer(signal.ITIMER_REAL, 0)
        if process.poll() is None:
            stop_owned_tree(process.pid, include_root=True, root_birth=root_birth)
        process.wait(timeout=5)
        try:evidence=capture.stop()
        except (OSError,RuntimeError,ValueError,subprocess.SubprocessError):evidence={'status':'failed','complete':False,'lostEvents':0,'pidNamespaceVerified':False,'events':[],'eventCount':0}
        reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        if evidence.get('reason') and evidence['reason']!=reason:
            evidence.setdefault('recordErrors',[]).append({'reason':evidence['reason']})
        evidence.update(status='failed',complete=False,reason=reason)
        evidence.setdefault('recordErrors',[]).append({'reason':reason})
        if not remaining: raise CaptureInterrupted('capture_timeout')
        signal.setitimer(signal.ITIMER_REAL, remaining)
    stderr_stream.close()
    stderr=stderr_path.read_bytes()
    # Restore command diagnostics, but never retain them in JSON/artifacts.
    if hasattr(sys.stderr,'buffer'):sys.stderr.buffer.write(stderr);sys.stderr.buffer.flush()
    else:sys.stderr.write(stderr.decode('utf8','replace'))
    unsupported=unsupported_personalities(stderr.decode('utf8','replace'))
    process.returncode=process.returncode if process.returncode is not None else INCOMPLETE
    paths = [trace] if trace.exists() else []
    if not evidence.get('complete'):
        print('Kernel capture incomplete: '+json.dumps({key:evidence.get(key) for key in
              ('reason','recordErrors','kernelCounts','captureChecks','diagnostics','recorderExitCode',
               'preEntryProbe','socketSymbols')}),file=sys.stderr)
    report, whole, summarize = measure_processes(paths, scope_executables, require_executables, True, evidence,
                                                 retain_task_trace=task_evidence_fits(evidence_deadline))
    measurements = (report,) if whole is report else (report, whole)
    for measurement in measurements:
        measurement['taskEvidenceStatus'] = 'unavailable'
        measurement['straceDiagnostics']={'unsupportedPersonalities':unsupported}
        if unsupported:
            measurement['classificationIssues'].append({'reason':'unsupported_strace_personality'})
            measurement['classificationErrors']+=1
            measurement['unparsedRecords']+=1
    complete = bool(report['traceFiles']) and report['processCount'] > 0 and report['unparsedRecords'] == 0
    code = INCOMPLETE if not complete else DENIED if report['externalAttempts'] else process.returncode
    verdict = dict(commandExitCode=process.returncode,
        observedRejectedOpcodes=sorted({event['opcode'] for event in evidence.get('events', [])
            if event.get('kind') in ('submit', 'failed') and event.get('opcode') not in ALLOWED_OPCODES}),
        commandStarted=command_started, captureTimeoutSeconds=capture_timeout, enforcement='blocking',
        status='passed' if code == 0 else 'failed', evidenceComplete=complete,
        outcome=('evidence_incomplete' if not complete else 'external_attempts' if report['externalAttempts']
                 else 'command_failed' if process.returncode else 'passed'))
    replay = allow_recapture and should_recapture(report | verdict)
    recording = None
    if replay:
        summarize = None
        for measurement in measurements:
            measurement['taskEvidenceStatus'] = 'discarded-before-recapture'
    elif evidence.get('reason') in ('capture_timeout', 'capture_cancelled'):
        summarize = None
    elif summarize is not None and not evidence.get('complete') and not isinstance(evidence.get('network'), dict):
        # Only a missing parsed kernel channel needs an extra input copy. Give
        # it a separate clock, leaving the active capture budget and the outer
        # supervisor's required report allowance available for the verdict.
        required_capture = signal.getitimer(signal.ITIMER_REAL)[0] if math.isfinite(evidence_deadline) else 0
        reserve = required_capture + REPORT_HISTORY_RESERVE + TASK_EVIDENCE_INPUT_TIMEOUT
        if task_evidence_fits(evidence_deadline, reserve=reserve):
            try:
                with capture_deadline(TASK_EVIDENCE_INPUT_TIMEOUT, handle_sigterm=False, timeout_error=TimeoutError):
                    recording = read_task_recording(directory)
            except CaptureInterrupted:
                raise
            except Exception:
                summarize = None
        else:
            summarize = None

    # Match the base post-analysis cleanup for every capture. From here on,
    # required writers and any later capture have no raw or diagnostic files.
    raw_capture.close()

    recipes = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ('outboundAudit.py', 'outboundScope.py', 'udpLifecycle.py')}
    recipes.update({f'uring/{path.name}':hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in Path(__file__).with_name('uring').glob('*.py')})
    tracer_metadata=None
    if evidence.get('complete'):
        version=subprocess.check_output([tracer,'--version'],text=True)
        tracer_metadata={'version':version.splitlines()[0],
                         'optionalFeatures':version.split('Optional features enabled:',1)[-1].strip(),
                         'binarySha256':hashlib.sha256(Path(tracer).read_bytes()).hexdigest()}
    report['strace'] = tracer_metadata
    whole['strace'] = tracer_metadata
    report['sourceSha256'] = recipes
    whole['sourceSha256'] = recipes
    if whole_report_path is not None:
        whole.update(commandExitCode=process.returncode, status='reported', enforcement='report-only')
        whole_report_path.parent.mkdir(parents=True, exist_ok=True)
        whole_report_path.write_text(json.dumps(whole, indent=2) + '\n')
    report.update(verdict)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('status', 'externalAttempts', 'unparsedRecords', 'commandExitCode')}))
    if summarize is None:
        return code, None, replay

    namespace = capture.namespace
    def collect():
        return summarize(diagnostic_task_snapshot(recording, namespace))

    return code, collect, False


def positive_control():
    """Deliberately attempt denied TCP and UDP, including on a network-none Docker."""
    import socket
    for kind in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        with socket.socket(socket.AF_INET, kind) as connection:
            connection.settimeout(0.2)
            try:
                if kind == socket.SOCK_STREAM:
                    connection.connect(('203.0.113.1', 443))
                else:
                    connection.sendto(b'control', ('203.0.113.1', 53))
            except OSError:
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--capture-timeout', type=float, default=CAPTURE_TIMEOUT)
    parser.add_argument('--task-evidence-deadline', type=float, help=argparse.SUPPRESS)
    parser.add_argument('--supervise', type=float)
    parser.add_argument('--scope-executable', action='append', type=Path, default=[], help='Successful exec roots whose complete descendant trees are enforced')
    parser.add_argument('--require-executable', action='append', type=Path, default=[], help='Selected executable that must be observed at least once')
    parser.add_argument('--whole-report', type=Path, help='Separate report-only whole-command measurement when scoped')
    parser.add_argument('--single-capture', action='store_true',
                        help='Fail on the first incomplete capture (for non-replayable negative control fixtures)')
    parser.add_argument('--transport-controls', type=Path)
    from uring.socketObjects import CONTROL_MODES
    parser.add_argument('--udp-control', choices=['connect-close', 'send', 'inherit-dup-send', 'uring-writev', 'uring-async-writev', *CONTROL_MODES])
    parser.add_argument('--positive-control', action='store_true')
    parser.add_argument('--child-positive-control', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.supervise is not None:
        command = args.command[1:] if args.command[:1] == ['--'] else args.command
        return supervise(command, args.supervise)
    if args.capture_timeout <= 0: parser.error('--capture-timeout must be positive')
    if args.transport_controls:
        from udpLifecycle import verify_controls
        return verify_controls(Path(__file__).resolve(), args.transport_controls.resolve())
    if args.udp_control:
        from udpLifecycle import control
        return control(args.udp_control)
    if args.child_positive_control:
        return subprocess.run([sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--positive-control']).returncode
    if args.positive_control:
        positive_control()
        return 0
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or not args.report:
        parser.error('--report and command after -- are required')
    if args.whole_report and args.whole_report.resolve() == args.report.resolve():
        parser.error('Scoped and whole reports must use different paths')
    if args.whole_report and not args.scope_executable:
        parser.error('--whole-report requires --scope-executable')
    if any(path.resolve() not in [item.resolve() for item in args.scope_executable] for path in args.require_executable):
        parser.error('--require-executable must also be selected by --scope-executable')
    for path in args.scope_executable:
        if not path.is_file(): parser.error('Scope executable must exist')
    if sys.platform == 'linux' and ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('audit_subreaper_unavailable')
    try:
        return audit(command, args.report, scope_executables=args.scope_executable,
                     require_executables=args.require_executable, whole_report_path=args.whole_report,
                     recapture=not args.single_capture, capture_timeout=args.capture_timeout,
                     task_evidence_deadline=args.task_evidence_deadline)
    finally:
        if sys.platform == 'linux': stop_owned_tree(os.getpid())


if __name__ == '__main__':
    sys.exit(main())
