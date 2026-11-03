"""Attribute Linux syscall attempts to threads and fail on any external destination.

The PR #35 parser/policy stays byte-identical at its original path. This wrapper
adds strace PID/comm attribution and accounts for syscalls interrupted by process
termination without dropping their already-observed destinations. No payloads or
execve arguments are recorded. Raw temporary traces are deleted after analysis.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

FIXTURE = Path(__file__).resolve().parents[1] / 'studio-preview/fixtures/outboundAudit.py'
spec = importlib.util.spec_from_file_location('outbound_fixture', FIXTURE)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
THREAD = re.compile(r'^(\d+)<([^>]+)>\s+(.*)$')


def analyze_trace(path):
    """Use the shared destination policy; keep every traced thread in scope."""
    threads, names, unknown, interrupted = {}, {}, 0, 0
    for line in path.read_text().splitlines():
        match = THREAD.match(line)
        if not match:
            unknown += 1
            continue
        pid, name, call = match.groups()
        threads.setdefault(pid, []).append(call)
        names.setdefault(pid, set()).add(name)
    processes = []
    with tempfile.TemporaryDirectory(prefix='studio-audit-parser-') as directory:
        for pid, lines in threads.items():
            # A process can die inside an IPC/network syscall. The destination
            # attempt is already observable even when no return value exists.
            pending, normalized = None, []
            for line in lines:
                if '<unfinished ...>' in line:
                    if pending is not None:
                        unknown += 1
                    pending = line.replace('<unfinished ...>', '')
                elif line.startswith('<... ') and ' resumed>' in line:
                    if pending is None:
                        unknown += 1
                    else:
                        normalized.append(pending + line.split(' resumed>', 1)[1])
                        pending = None
                elif line.startswith('+++') and pending is not None:
                    # Only a terminal record establishes that the pending syscall
                    # was interrupted. Missing terminal evidence still fails closed.
                    normalized.append(pending + ') = ?')
                    pending = None
                    interrupted += 1
                    normalized.append(line)
                else:
                    normalized.append(line)
            if pending is not None:
                unknown += 1
            for record in normalized:
                if policy.CALL.match(record) and (
                    '= ' not in record or ('sa_family=AF_' not in record and 'NULL' not in record)
                ):
                    unknown += 1
            fragment = Path(directory) / pid
            fragment.write_text('\n'.join(normalized))
            result = policy.analyze([fragment])
            unknown += result['unparsedRecords']
            processes.append({
                'tid': int(pid), 'processNames': sorted(names[pid]),
                'destinationAttempts': result['destinationAttempts'],
                'externalAttempts': result['externalAttempts'], 'external': result['external'],
            })
    return {
        'schema': 'aelix-studio.outbound-audit/1', 'scope': 'command-and-all-descendants',
        'traceThreads': len(threads), 'destinationAttempts': sum(p['destinationAttempts'] for p in processes),
        'externalAttempts': sum(p['externalAttempts'] for p in processes),
        'unparsedRecords': unknown, 'interruptedSyscalls': interrupted,
        'processes': [p for p in processes if p['externalAttempts']],
    }


def audit(command, report_path):
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {'schema': 'aelix-studio.outbound-audit/1', 'status': 'failed'}
    proxy_keys = [key for key, value in os.environ.items() if value.strip() and key.lower().replace('-', '_') in
                  ('http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy')]
    try:
        if proxy_keys or policy.npm_proxy_configured(policy.npm_config_paths()):
            raise RuntimeError('Proxy configuration can hide external destinations')
        if sys.platform != 'linux' or not shutil.which('strace'):
            raise RuntimeError('Linux strace is required; the audit cannot be skipped')
        with tempfile.TemporaryDirectory(prefix='studio-outbound-') as directory:
            trace = Path(directory) / 'network'
            process = subprocess.run(['strace', '-f', '-Y', '-q', '-v', '-s', '0', '-e',
                                      'trace=connect,sendto,sendmsg,sendmmsg', '-o', str(trace), '--', *command])
            report = analyze_trace(trace)
        report['commandExitCode'] = process.returncode
        complete = report['traceThreads'] > 0 and report['unparsedRecords'] == 0
        code = policy.INCOMPLETE if not complete else policy.DENIED if report['externalAttempts'] else process.returncode
    except (OSError, UnicodeError, RuntimeError) as error:
        report['reason'] = str(error)
        code = policy.INCOMPLETE
    report['status'] = 'passed' if code == 0 else 'failed'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: value for key, value in report.items() if key != 'processes'}))
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('A command after -- is required')
    return audit(command, args.report)


if __name__ == '__main__':
    sys.exit(main())
