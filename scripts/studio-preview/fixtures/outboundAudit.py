"""Linux OS-level outbound-attempt audit for a command and all its descendants.

Counts attempted connect/sendto/sendmsg/sendmmsg destinations, including failed
syscalls, from exec through final child exit. Unix/kernel IPC and loopback are
allowed; DNS port 53 is denied even on loopback (a local resolver may forward it).
Raw traces use -s 0 and are deleted; reports contain PID/comm and network metadata, no payloads.
Optional executable roots select descendant trees; the default remains whole-command enforcement.
Exit 86 means detected outbound attempts; 87 means incomplete/unparseable evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from outboundScope import analyze_processes

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


def audit(command, report_path, *, scope_executables=(), require_executables=(), whole_report_path=None):
    proxy_keys = [key for key, value in os.environ.items() if value.strip() and key.lower().replace('-', '_') in ('http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy')]
    if proxy_keys:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps({'schema': 'aelix-studio-host.outbound-audit/1', 'status': 'failed', 'reason': 'proxy_environment', 'proxyKeys': proxy_keys}) + '\n')
        print('Audit refused: proxy environment may hide destination attempts', file=sys.stderr)
        return INCOMPLETE
    try:
        npm_proxy = npm_proxy_configured(npm_config_paths())
    except (OSError, UnicodeError):
        npm_proxy = None
    if npm_proxy is not False:
        reason = 'npm_proxy_configuration' if npm_proxy else 'npm_configuration_unreadable'
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps({'schema': 'aelix-studio-host.outbound-audit/1', 'status': 'failed', 'reason': reason}) + '\n')
        print('Audit refused: npm configuration may hide destination attempts', file=sys.stderr)
        return INCOMPLETE
    if sys.platform != 'linux' or shutil.which('strace') is None:
        raise RuntimeError('Linux strace is required; audit cannot be skipped')
    with tempfile.TemporaryDirectory(prefix='host-outbound-audit-') as directory:
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
        process = subprocess.run(['strace', '-f', '--decode-pids=comm,pidns', '-yy', '-q', '-s', '0', '-e', 'abbrev=!sendmmsg', '-e',
                                  'trace=connect,sendto,sendmsg,sendmmsg,io_uring_setup,io_uring_enter,io_uring_register,clone,clone3,fork,vfork,execve,execveat',
                                  '-o', str(trace), '--', *command])
        paths = [trace] if trace.exists() else []
        report, whole = analyze_processes(paths, scope_executables, require_executables, True)
    recipes = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
               for name in ('outboundAudit.py', 'outboundScope.py')}
    report['sourceSha256'] = recipes
    whole['sourceSha256'] = recipes
    if whole_report_path is not None:
        whole.update(commandExitCode=process.returncode, status='reported', enforcement='report-only')
        whole_report_path.parent.mkdir(parents=True, exist_ok=True)
        whole_report_path.write_text(json.dumps(whole, indent=2) + '\n')
    report['commandExitCode'] = process.returncode
    complete = bool(report['traceFiles']) and report['processCount'] > 0 and report['unparsedRecords'] == 0
    code = INCOMPLETE if not complete else DENIED if report['externalAttempts'] else process.returncode
    report['enforcement'] = 'blocking'
    report['status'] = 'passed' if code == 0 else 'failed'
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('status', 'externalAttempts', 'unparsedRecords', 'commandExitCode')}))
    return code


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
    parser.add_argument('--scope-executable', action='append', type=Path, default=[], help='Successful exec roots whose complete descendant trees are enforced')
    parser.add_argument('--require-executable', action='append', type=Path, default=[], help='Selected executable that must be observed at least once')
    parser.add_argument('--whole-report', type=Path, help='Separate report-only whole-command measurement when scoped')
    parser.add_argument('--positive-control', action='store_true')
    parser.add_argument('--child-positive-control', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
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
    return audit(command, args.report, scope_executables=args.scope_executable,
                 require_executables=args.require_executable, whole_report_path=args.whole_report)


if __name__ == '__main__':
    sys.exit(main())
