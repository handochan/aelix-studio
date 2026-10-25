"""Verify the actual Electron selector and tool policy with a pinned recovery host.

Run with the public-wheel native Python from the ACP #5 qualification runtime.
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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def run(args, report):
    sys.path.insert(0, str(args.acp_source / 'scripts'))
    from qualify_permissions import ToolFixture, host_identity, wrapper
    from beta2_identity import verify
    from qualify_beta2 import adapter_receipt

    binary = args.host_receipt.parent / 'aioncore'
    identity = host_identity(binary, args.host_receipt, HERE / 'source.json')
    manifest = json.loads((args.acp_source / 'docs/beta2/manifest.json').read_text())

    def audit():
        return {'native': verify(manifest, args.artifacts), 'adapter': adapter_receipt(args.adapter)}

    report['identityBefore'] = audit()
    report['hostIdentity'] = identity
    report['acpSourceCommit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.acp_source, text=True).strip()
    report['acpHarnessSha256'] = digest(args.acp_source / 'scripts/qualify_permissions.py')
    report['builtAppSha256'] = {name: digest(ROOT / name) for name in ('out/main/index.js', 'out/preload/index.js')}

    class ControlledFixture(ToolFixture):
        async def respond(self, reader, writer):
            request_path = self.root / 'tool-request.json'
            if request_path.exists():
                self.next_tool = json.loads(request_path.read_text())
                request_path.unlink()
            await super().respond(reader, writer)

    with tempfile.TemporaryDirectory(prefix='studio-permission-recovery-') as temporary:
        sandbox = Path(temporary).resolve()
        fixture = ControlledFixture(sandbox)
        # The base fixture intentionally keeps its root private to setup.
        fixture.root = sandbox
        await fixture.start()
        native = Path(sys.executable).parent / 'aelix'
        launch = wrapper(sandbox, native)
        (sandbox / 'extensions').mkdir()
        env = dict(fixture.env, PERMISSION_PROBE_ROOT=str(sandbox), RECOVERY_SANDBOX=str(sandbox),
                   RECOVERY_OUTPUT=str(args.report.parent), RECOVERY_ADAPTER=str(args.adapter),
                   RECOVERY_NATIVE_WRAPPER=str(launch), AIONUI_BACKEND_BIN=str(binary), AIONUI_E2E_TEST='1',
                   AIONUI_E2E_USER_DATA_DIR=str(sandbox / 'studio'), AIONUI_DISABLE_DEVTOOLS='1',
                   AIONUI_DISABLE_AUTO_UPDATE='1', AIONUI_CDP_PORT='0',
                   AIONUI_EXTENSIONS_PATH=str(sandbox / 'extensions'),
                   AIONUI_EXTENSION_STATES_FILE=str(sandbox / 'extension-states.json'))
        process = None
        try:
            process = await asyncio.create_subprocess_exec('node', str(HERE / 'smoke.mjs'), cwd=ROOT, env=env, start_new_session=True)
            async with asyncio.timeout(240):
                if await process.wait():
                    raise RuntimeError('Electron permission recovery smoke failed')
            observed = json.loads((args.report.parent / 'renderer-result.json').read_text())
            report.update(observed)
            assert fixture.requests and all(item['model'] == 'one' for item in fixture.requests)
            report['providerRequests'] = len(fixture.requests)
            report['identityAfter'] = audit()
            assert report['identityAfter'] == report['identityBefore']
            assert digest(binary) == identity['binarySha256']
            report['status'] = 'passed'
        finally:
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 10)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            await fixture.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--acp-source', type=Path, required=True)
    parser.add_argument('--adapter', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--host-receipt', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    for name in vars(args):
        setattr(args, name, getattr(args, name).resolve())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    report = {'schema': 'aelix-studio.permission-recovery-ui/1', 'status': 'failed',
              'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'nativePatches': [], 'realProvider': False, 'installer': False, 'provider': 'synthetic loopback',
              'harnessSha256': {name: digest(HERE / name) for name in ('smoke.py', 'smoke.mjs')}}
    try:
        if not __debug__:
            raise RuntimeError('Permission recovery qualification requires Python without -O')
        asyncio.run(run(args, report))
    finally:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'checks': len(report['checksPassed'])}))


if __name__ == '__main__':
    main()
