"""Run the actual Studio renderer/backend with the pinned ACP loopback fixture."""
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
import signal

from prepare import verify_prepared

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / '.local/studio-preview'


async def main():
    report_path = RUNTIME / 'host-smoke.json'
    report_path.write_text(json.dumps({'status': 'running', 'stage': 'preflight'}) + '\n')
    if not __debug__:
        raise RuntimeError('Qualification requires assertions enabled')
    receipt = verify_prepared(RUNTIME)
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    binary = RUNTIME / receipt['aioncoreBinary']
    source = RUNTIME / 'source' / ('aelix-acp-' + receipt['acp']['commit'])
    qualification = json.loads((RUNTIME / 'qualification.json').read_text())
    for name, expected in qualification['harnessSourceSha256'].items():
        if digest(source / 'scripts' / name) != expected:
            raise ValueError('Qualified ACP harness bytes changed')
    def audit():
        code = '''import json,sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from beta2_identity import verify
from qualify_beta2 import adapter_receipt
root=Path(sys.argv[2])
manifest=json.loads(Path(sys.argv[3]).read_text())["native"]
print(json.dumps({"native":verify(manifest,root/"wheels"),"adapter":adapter_receipt(root/"adapter/bin/aelix-acp")}))'''
        result = subprocess.check_output([str(RUNTIME / 'native/bin/python'), '-I', '-B', '-c', code,
            str(source / 'scripts'), str(RUNTIME), str(Path(__file__).with_name('baseline.json'))],
            cwd=RUNTIME, env={key: os.environ[key] for key in ('PATH', 'TMP', 'TEMP') if key in os.environ}, text=True, timeout=120)
        observed = json.loads(result)
        if observed['adapter'] != qualification['installedAdapter']:
            raise ValueError('Installed ACP differs from the qualified source pin')
        return observed
    identity_before = audit()
    spec = importlib.util.spec_from_file_location('preview_wire', source / 'scripts/beta2_wire.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='studio-preview-') as temporary:
        sandbox = Path(temporary)
        fixture = module.Fixture(sandbox)
        await fixture.start()
        async def observe_hold():
            await fixture.entered.wait()
            (sandbox / 'provider-held').touch()
        hold_observer = asyncio.create_task(observe_hold())
        env = dict(fixture.env, PREVIEW_RUNTIME=str(RUNTIME), PREVIEW_SANDBOX=str(sandbox),
                   AIONUI_BACKEND_BIN=str(binary), AIONUI_E2E_TEST='1',
                   AIONUI_E2E_USER_DATA_DIR=str(sandbox / 'studio'), AIONUI_DISABLE_DEVTOOLS='1',
                   AIONUI_DISABLE_AUTO_UPDATE='1', AIONUI_CDP_PORT='0',
                   AIONUI_EXTENSIONS_PATH=str(sandbox / 'extensions'),
                   AIONUI_EXTENSION_STATES_FILE=str(sandbox / 'extension-states.json'))
        (sandbox / 'extensions').mkdir()
        try:
            process = await asyncio.create_subprocess_exec('node', str(Path(__file__).with_name('hostSmoke.mjs')),
                                                          cwd=ROOT, env=env, start_new_session=True)
            async with asyncio.timeout(180):
                code = await process.wait()
            if code:
                raise RuntimeError('Studio host smoke failed')
            if not fixture.requests or any(request['model'] != 'one' for request in fixture.requests):
                raise AssertionError('Host did not reach the selected native model')
            if not fixture.entered.is_set():
                raise AssertionError('Stop was not tested during a held provider request')
            report = json.loads((RUNTIME / 'host-smoke.json').read_text())
            report.update(provider='synthetic loopback', nativeModel='one',
                          providerRequests=len(fixture.requests), nativePatches=[], realProvider=False, installer=False)
            identity_after = audit()
            if identity_before != identity_after:
                raise AssertionError('Installed native/ACP payload changed during host smoke')
            report.update(identityBefore=identity_before, identityAfter=identity_after,
                          baselineSha256=receipt['baselineSha256'], aioncoreBinarySha256=receipt['aioncoreBinarySha256'],
                          harnessSourceSha256={name: digest(Path(__file__).parent / name) for name in
                              ('prepare.py', 'smoke.py', 'hostSmoke.mjs', 'host-forwarding/launch.cjs')},
                          builtAppSha256={name: digest(ROOT / name) for name in ('out/main/index.js', 'out/preload/index.js')})
            report['status'] = 'passed'
            report_path.write_text(json.dumps(report, indent=2) + '\n')
        finally:
            if 'process' in locals() and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 10)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            hold_observer.cancel()
            await asyncio.gather(hold_observer, return_exceptions=True)
            await fixture.close()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except BaseException:
        if RUNTIME.is_dir():
            (RUNTIME / 'host-smoke.json').write_text(json.dumps({'status': 'failed'}) + '\n')
        raise
