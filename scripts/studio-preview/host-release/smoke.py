"""Verify the actual Electron selector and tool policy with a pinned released host.

Run with the candidate native Python from the prepared Studio runtime.
Only isolated temporary state and synthetic loopback model responses are used.
"""
import argparse
import asyncio
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]

# This released host predates guarded Fork. A replacement release is expected
# to support it. The result cannot choose its mode from a live capability.
LEGACY_FORK_HOST = 'c516fa946ef48adc0119dbf37367e02216b22e70'
FORK_CHECK = {'legacy': 'installed_legacy_host_refuses_unanchored_native_fork',
              'guarded': 'installed_native_head_fork_ui_and_child_restart'}


def expected_fork_mode(host_commit):
    return 'legacy' if host_commit == LEGACY_FORK_HOST else 'guarded'


def verify_fork_result(mode, checks, requests):
    if {check for check in checks if check in FORK_CHECK.values()} != {FORK_CHECK[mode]}:
        raise AssertionError(f'Expected the installed {mode} fork qualification')
    if mode == 'legacy':
        return
    fork_parent = 'SYNTHETIC_HEAD_FORK_PARENT'
    fork_child = 'SYNTHETIC_HEAD_FORK_CHILD'
    for marker, expected in ((fork_child, (fork_parent,)),
                             ('SYNTHETIC_HEAD_FORK_RESTART', (fork_parent, fork_child))):
        turns = [request['messages'] for request in requests
                 if request['messages'] and marker in json.dumps(request['messages'][-1])]
        if len(turns) != 1 or any(text not in json.dumps(turns[0][:-1]) for text in expected):
            raise AssertionError(f'Installed native fork lost context at {marker}')
    checks.append('installed_native_head_fork_context_after_restart')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def gui_environment(base, environment=None):
    # Preserve only the Xvfb display transport from the driver. Provider routing,
    # credentials and user roots still come exclusively from the isolated fixture.
    source = os.environ if environment is None else environment
    return dict(base, **{key: source[key] for key in ('DISPLAY', 'XAUTHORITY') if key in source})


def validate_installed_python_alias(alias, python):
    # Windows junction resolution can retain a \\?\ prefix on only one path.
    # Compare OS file identity, while retaining the probe's whitespace boundary.
    if not alias.samefile(python) or any(char.isspace() for char in str(alias)):
        raise ValueError('Custom-agent test requires an owned whitespace-free alias to installed Python')


async def run_installed(args, report):
    sys.path.insert(0, str(HERE.parent))
    from prepare import verify_prepared
    runtime, payload = args.runtime.resolve(), args.payload.resolve()
    receipt = verify_prepared(runtime)
    fork_mode = expected_fork_mode(receipt['aioncore']['commit'])
    source = runtime / 'source' / ('aelix-acp-' + receipt['acp']['commit'])
    sys.path.insert(0, str(HERE.parent / 'fixtures'))
    sys.path.insert(0, str(HERE.parent / 'packaging'))
    from loopback import ToolFixture
    from runtime import verify, adapter_receipt
    payload_manifest = json.loads((payload / 'manifest.json').read_text(encoding='utf-8'))
    if payload_manifest['preparedReceiptSha256'] != digest(runtime / 'receipt.json') or payload_manifest['nativePatches']:
        raise ValueError('Installed permission runtime differs from the prepared pairing')
    python = payload / ('python/python.exe' if os.name == 'nt' else 'python/bin/python3')
    prefix = ['-I', '-S', '-B', '-X', 'utf8', str(payload / 'launch.py')]
    adapter = runtime / 'adapter' / ('Scripts/aelix-acp.exe' if os.name == 'nt' else 'bin/aelix-acp')

    def inventory():
        return {file.relative_to(payload).as_posix(): digest(file) for file in payload.rglob('*') if file.is_file()}

    def audit():
        return {'native': verify(receipt['native'], runtime / 'wheels'), 'adapter': adapter_receipt(adapter, source / 'src/aelix_acp')}

    before = inventory()
    report.update(installer=True, identityBefore=audit(), acpSourceCommit=receipt['acp']['commit'],
                  expectedForkMode=fork_mode,
                  hostBuildReceipt=json.loads((runtime / 'aioncore/build-receipt.json').read_text()),
                  preparedReceiptSha256=digest(runtime / 'receipt.json'), installedPayloadManifestSha256=digest(payload / 'manifest.json'))

    class ControlledFixture(ToolFixture):
        async def respond(self, reader, writer):
            request_path = self.root / 'tool-request.json'
            if request_path.exists():
                self.next_tool = json.loads(request_path.read_text())
                request_path.unlink()
            await super().respond(reader, writer)

    with tempfile.TemporaryDirectory(prefix='studio-permission-user-') as temporary:
        sandbox = Path(temporary).resolve()
        fixture = ControlledFixture(sandbox)
        fixture.root = sandbox
        await fixture.start()
        profiles = sandbox / 'agent/agents'
        profiles.mkdir()
        (profiles / 'reviewer.md').write_text('---\nname: reviewer\ndescription: Synthetic delegation\ntools: [read]\n---\nRespond briefly.\n', encoding='utf-8')
        # The host's custom-agent probe tokenizes its command field on spaces.
        # An owned directory alias keeps the executable inside the actual installed
        # payload; no system/developer Python or copied runtime is substituted.
        alias = sandbox / 'bundled-python'
        if os.name == 'nt':
            subprocess.run(['cmd', '/d', '/c', 'mklink', '/J', str(alias), str(payload / 'python')],
                           check=True, stdout=subprocess.DEVNULL)
        else:
            alias.symlink_to(payload / 'python', target_is_directory=True)
        adapter_python = alias / ('python.exe' if os.name == 'nt' else 'bin/python3')
        validate_installed_python_alias(adapter_python, python)
        extension = sandbox / 'permission_fixture.py'
        extension.write_text((HERE.parent / 'fixtures/permission_fixture_extension.py').read_text() + '''

_original_setup = setup

def setup(api):
    import asyncio
    _original_setup(api)
    async def hold(args, context):
        root = Path(os.environ['PERMISSION_PROBE_ROOT'])
        (root / 'tool-entered').touch()
        try:
            await asyncio.sleep(30)
            (root / 'workspace/late-write.txt').write_text('synthetic')
        except asyncio.CancelledError:
            (root / 'tool-cancelled').touch()
            raise
        return ToolResult(content=[TextContent(text='synthetic hold completed')])
    api.register_tool(AgentTool(name='probe_hold', description='Synthetic cancellable hold',
        parameters={'type':'object','properties':{}}, execute=hold))
''', encoding='utf-8')
        wrapper = sandbox / 'native-wrapper.py'
        wrapper.write_text((HERE.parent / 'fixtures/nativeFailure.py').read_text() +
            f'\nrun(Path({str(sandbox)!r}), Path({str(payload)!r}), Path({str(extension)!r}), sys.argv[1:])\n', encoding='utf-8')
        import base64
        from urllib.parse import quote
        config = sandbox / 'studio/config/aionui-config.txt'
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(base64.b64encode(quote(json.dumps({'update.autoCheck': False}), safe='').encode()).decode())
        command = [*prefix, 'acp', '--aelix', str(python), '--aelix-arg=-I', '--aelix-arg=-S', '--aelix-arg=-B',
                   '--aelix-arg=-Xutf8', '--aelix-arg=' + str(wrapper), '--provider', 'fixture', '--model', 'one',
                   '--state-dir', str(sandbox / 'acp')]
        fork_wire_log = sandbox / 'fork-wire.jsonl'
        fork_probe = HERE / 'probes/installedFork.py'
        fork_adapter_args = ['-I', '-S', '-B', '-X', 'utf8', str(fork_probe), 'record',
                             str(fork_wire_log), str(python), *command]
        (sandbox / 'extensions').mkdir()
        # Challenge the product launcher rather than suppressing bytecode in the fixture.
        env = dict(fixture.env, PYTHONDONTWRITEBYTECODE='0', NO_PROXY='127.0.0.1,localhost',
                   XDG_CONFIG_HOME=str(sandbox / 'home/config'), XDG_CACHE_HOME=str(sandbox / 'home/cache'),
                   APPDATA=str(sandbox / 'home/appdata'), LOCALAPPDATA=str(sandbox / 'home/localappdata'),
                   PERMISSION_PROBE_ROOT=str(sandbox), RECOVERY_SANDBOX=str(sandbox), RECOVERY_OUTPUT=str(args.report.parent),
                   RECOVERY_ADAPTER=str(adapter_python), RECOVERY_ADAPTER_ARGS=json.dumps(command),
                   RECOVERY_EXPECTED_FORK_MODE=fork_mode, RECOVERY_FORK_WIRE_LOG=str(fork_wire_log),
                   RECOVERY_FORK_ADAPTER_ARGS=json.dumps(fork_adapter_args),
                   RECOVERY_DELEGATION_ARGS=json.dumps([*command, '--enable-agents', '--permission-mode', 'yolo']),
                   RECOVERY_OBSERVER_ARGS=json.dumps([str(python), *prefix]),
                   RECOVERY_APP_EXECUTABLE=os.environ['PROVIDER_APP_EXECUTABLE'],
                   DEBUG='pw:browser', AIONUI_E2E_TEST='1', AIONUI_E2E_USER_DATA_DIR=str(sandbox / 'studio'),
                   AIONUI_DISABLE_DEVTOOLS='1', AIONUI_CDP_PORT='0',
                   AIONUI_EXTENSIONS_PATH=str(sandbox / 'extensions'),
                   AIONUI_EXTENSION_STATES_FILE=str(sandbox / 'extension-states.json'))
        env = gui_environment(env)
        process = None
        try:
            process = await asyncio.create_subprocess_exec('node', str(HERE / 'probes/smoke.mjs'), cwd=ROOT, env=env,
                **({'start_new_session': True} if os.name != 'nt' else {}))
            async with asyncio.timeout(360):
                if await process.wait():
                    raise RuntimeError('Installed Electron permission qualification failed')
            report.update(json.loads((args.report.parent / 'renderer-result.json').read_text()))
            if inventory() != before:
                raise AssertionError('Installed payload changed during permission qualification')
            report['identityAfter'] = audit()
            report['checksPassed'].append('delegation_payload_inventory_unchanged')
            if report['identityAfter'] != report['identityBefore']:
                raise AssertionError('Public native or installed adapter identity changed')
            if not fixture.requests or not all(item['model'] == 'one' for item in fixture.requests):
                raise AssertionError('No real synthetic native model requests observed')
            verify_fork_result(fork_mode, report['checksPassed'], fixture.requests)
            report.update(status='passed', providerRequests=len(fixture.requests), installedPayloadUnchanged=True,
                          installedFiles=len(before), defaultHostOverride=False)
        finally:
            if process and process.returncode is None:
                if os.name == 'nt':
                    cleanup = await asyncio.create_subprocess_exec('taskkill', '/PID', str(process.pid), '/T', '/F',
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                    await cleanup.wait()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            await fixture.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--payload', type=Path)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    for name in vars(args):
        if getattr(args, name) is not None:
            setattr(args, name, getattr(args, name).resolve())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {'schema': 'aelix-studio.permission-recovery-ui/1', 'status': 'failed',
              'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'nativePatches': [], 'realProvider': False, 'installer': False, 'provider': 'synthetic loopback',
              'harnessSha256': {name: digest(HERE / name) for name in ('smoke.py', 'probes/smoke.mjs', 'verification.mjs',
                  'probes/protocolDiagnostics.mjs', 'probes/processTimeline.mjs', 'probes/linuxProcesses.mjs', 'probes/windowsProcesses.mjs', 'probes/installedFork.py', '../fixtures/nativeFailure.py', '../../../tests/manual/recoveredProfile.mjs')}}
    try:
        if not __debug__:
            raise RuntimeError('Permission recovery qualification requires Python without -O')
        asyncio.run(run_installed(args, report))
    finally:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'checks': len(report['checksPassed'])}))


if __name__ == '__main__':
    main()
