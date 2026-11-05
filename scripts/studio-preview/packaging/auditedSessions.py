"""Record each installed host/native audit session and its separate whole-app report."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AuditedSessions:
    def __init__(self, core, native, directory):
        self.core, self.native, self.directory = core.resolve(), native.resolve(), directory.resolve()
        self.auditor = Path(__file__).parents[1] / 'fixtures/outboundAudit.py'
        self.root = Path(__file__).resolve().parents[3]
        self.enabled = sys.platform == 'linux'
        self.sessions, self.controls = [], []

    def save(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / 'outbound-sessions.json').write_text(json.dumps({
            'schema': 'aelix.scoped-audited-sessions/1', 'auditedSessions': self.sessions,
            'positiveControls': self.controls, 'recipeSha256': digest(Path(__file__))}, indent=2) + '\n')

    def run(self, name, command, *, env, timeout, required=(), expected_external=None,
            roots=None, namespace=False, defer_failure=False, expected_ring_opcode=None, **options):
        if not self.enabled:
            return subprocess.run(command, check=True, cwd=self.root, env=env, timeout=timeout, **options)
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name): raise ValueError('Invalid audit session name')
        self.directory.mkdir(parents=True, exist_ok=True)
        stem = '' if name == 'permission' else '-' + name
        report = self.directory / ('outbound' + stem + '.json')
        whole_path = self.directory / ('outbound-app' + stem + '.json')
        audited = [sys.executable, '-I', '-B', str(self.auditor)]
        for root in (roots if roots is not None else (self.core, self.native)):
            audited += ['--scope-executable', str(root)]
        for root in required: audited += ['--require-executable', str(root)]
        audited += ['--report', str(report), '--whole-report', str(whole_path), '--', *map(str, command)]
        if namespace:
            # A private namespace has no external interface/routes. Enable only
            # loopback for the control driver's local host API connection.
            for tool in ('sudo', 'unshare', 'ip'):
                if not shutil.which(tool): raise RuntimeError('Host control requires ' + tool)
            audited = ['sudo', '-n', shutil.which('unshare'), '--net', '--', '/bin/sh', '-c',
                       'ip link set lo up && exec "$@"', 'host-control', *audited]
        expected_code = 87 if expected_ring_opcode is not None else 0 if expected_external is None else 86
        record = {'name': name, 'status': 'running', 'expectedAuditExitCode': expected_code,
                  'report': report.name, 'wholeAppReport': whole_path.name}
        collection = self.sessions if expected_external is None and expected_ring_opcode is None else self.controls
        collection.append(record); self.save()
        try:
            result = subprocess.run(audited, cwd=self.root, env=env, timeout=timeout, **options)
            record.update(status='failed', auditExitCode=result.returncode)
            scoped, whole = json.loads(report.read_text()), json.loads(whole_path.read_text())
        except (subprocess.SubprocessError, OSError, ValueError) as error:
            record.update(status='failed', exceptionKind=type(error).__name__)
            self.save()
            raise
        for field in ('externalAttempts', 'unparsedRecords', 'classificationErrors', 'processCount'):
            record[field] = scoped[field]
        record.update(reportSha256=digest(report), wholeAppReportSha256=digest(whole_path),
                      commandExitCode=scoped.get('commandExitCode'),
                      udpConnectOnly=scoped.get('udpConnectOnly',0),
                      kernelResolvedRecords=scoped.get('kernelResolvedRecords',0),
                      wholeAppKernelResolvedRecords=whole.get('kernelResolvedRecords',0),
                      kernelNotExecutedInvocations=scoped.get('kernelNotExecutedInvocations',0),
                      wholeAppKernelNotExecutedInvocations=whole.get('kernelNotExecutedInvocations',0),
                      kernelNonNetworkWriteInvocations=scoped.get('kernelNonNetworkWriteInvocations',0),
                      wholeAppKernelNonNetworkWriteInvocations=whole.get('kernelNonNetworkWriteInvocations',0),
                      kernelResolvedResultFields=scoped.get('kernelResolvedResultFields',0),
                      wholeAppKernelResolvedResultFields=whole.get('kernelResolvedResultFields',0),
                      kernelMetadataResolvedRecords=scoped.get('kernelMetadataResolvedRecords',0),
                      wholeAppKernelMetadataResolvedRecords=whole.get('kernelMetadataResolvedRecords',0),
                      wholeAppUdpConnectOnly=whole.get('udpConnectOnly',0),
                      wholeAppClassificationErrors=whole['classificationErrors'],
                      ioUringOpcodes=scoped.get('ioUring',{}).get('opcodeCounts',{}),
                      wholeAppIoUringOpcodes=whole.get('ioUring',{}).get('opcodeCounts',{}),
                      wholeAppExternalAttempts=whole['externalAttempts'], wholeAppUnparsedRecords=whole['unparsedRecords'])
        valid = (result.returncode == expected_code and scoped['scope'] == 'selected-process-trees'
                 and scoped['enforcement'] == 'blocking' and scoped['externalAttempts'] == (expected_external or 0)
                 and scoped['unparsedRecords'] == 0 and scoped['classificationErrors'] == 0 and scoped['rootPids']
                 and whole['scope'] == 'all' and whole['enforcement'] == 'report-only'
                 and scoped.get('ioUring',{}).get('recorded') and scoped['ioUring']['capture']['complete']
                 and scoped['ioUring']['capture']['drained'] and scoped['ioUring']['capture']['lostEvents']==0)
        if expected_ring_opcode is not None:
            issues=scoped['classificationIssues']
            valid=(result.returncode==87 and scoped['externalAttempts']==0 and scoped['unparsedRecords']==1
                   and scoped['classificationErrors']==1 and len(issues)==1
                   and issues[0].get('reason')=='io_uring_opcode_not_allowed'
                   and issues[0].get('opcode')==expected_ring_opcode and scoped['rootPids']
                   and scoped['ioUring']['recorded'] and scoped['ioUring']['capture']['complete']
                   and scoped['ioUring']['capture']['lostEvents']==0
                   and scoped['ioUring']['capture']['drained']
                   and scoped['scope']=='selected-process-trees' and scoped['enforcement']=='blocking'
                   and whole['scope']=='all' and whole['enforcement']=='report-only'
                   and scoped.get('commandExitCode')==0)
            record['expectedRejectedOpcode']=expected_ring_opcode
        if valid: record['status'] = 'passed'
        self.save()
        if not valid and not (defer_failure and scoped.get('commandExitCode') == 0):
            raise RuntimeError('Scoped outbound session failed: ' + name)
        return result

    @property
    def failed(self):
        return [r['name'] for r in self.sessions + self.controls if r['status'] != 'passed']

    def positive_controls(self, env, *, defer_failure=False):
        for control in ('positive-control', 'child-positive-control'):
            self.run(control, [self.native, '-I', '-B', self.auditor, '--' + control], env=env,
                     timeout=60, required=(self.native,), expected_external=2, defer_failure=defer_failure)
            report = json.loads((self.directory / ('outbound-' + control + '.json')).read_text())
            if {event['syscall'] for event in report['external']} != {'connect', 'sendto'}:
                raise RuntimeError('Positive control syscall mismatch: ' + control)
        fixture = self.auditor.with_name('hostOutboundControl.py')
        proof = self.directory / 'outbound-host-control-fixture.json'
        self.run('host-control', [sys.executable, '-I', '-B', fixture, '--host', self.core,
                 '--native', self.native, '--receipt', proof,
                 '--parent-namespace', os.readlink('/proc/self/ns/net')], env=env,
                 timeout=180, roots=(self.core,), required=(self.core,), expected_external=2, namespace=True,
                 defer_failure=defer_failure)
        observed = json.loads(proof.read_text())
        report = json.loads((self.directory / 'outbound-host-control.json').read_text())
        if not (observed['privateNetworkNamespace'] and observed['onlyLoopbackInterface'] and observed['defaultRoutes'] == 0):
            raise RuntimeError('Host control network namespace mismatch')
        if not (observed['hostPid'] in report['rootPids'] and observed['childPid'] not in report['rootPids']):
            raise RuntimeError('Host control root mismatch')
        if {event['pid'] for event in report['external']} != {observed['childPid']}:
            raise RuntimeError('Host control child mismatch')
        if {event['syscall'] for event in report['external']} != {'connect', 'sendto'}:
            raise RuntimeError('Host control syscall mismatch')
        parents = {p['pid']: p['parentPid'] for p in report['processes']}
        current = observed['childPid']
        seen = set()
        while current != observed['hostPid']:
            if current in seen or current not in parents:
                raise RuntimeError('Missing host-child lineage')
            seen.add(current); current = parents[current]
        self.controls[-1].update(hostChildLineageVerified=True, privateNetworkNamespace=True,
                                 fixtureSha256=digest(proof), fixtureRecipeSha256=digest(fixture))
        self.save()
        # These network operations use an owned loopback target. They must be
        # rejected by opcode, without an address/name exception or real egress.
        sys.path.insert(0,str(self.auditor.parent))
        from uring.probe import CONTROL_C
        with tempfile.TemporaryDirectory(prefix='studio-uring-control-') as directory:
            source=Path(directory)/'control.c';source.write_text(CONTROL_C)
            binary=Path(directory)/'control'
            subprocess.run(['cc',str(source),'-o',str(binary),'-luring'],check=True,capture_output=True)
            for sqpoll in (False,True):
                code='import subprocess,sys;raise SystemExit(subprocess.run(sys.argv[1:]).returncode)'
                self.run('uring-connect-sqpoll' if sqpoll else 'uring-connect',
                    [self.native,'-I','-B','-c',code,str(binary),*(['sqpoll'] if sqpoll else [])],
                    env=env,timeout=90,required=(self.native,),expected_ring_opcode=16,defer_failure=defer_failure)
