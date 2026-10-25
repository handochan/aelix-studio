"""Qualify Provider registration against unchanged native wheels and the actual Studio UI.

Uses a disposable HOME and a local synthetic provider, never operator credentials.
Run after building Studio: python3 scripts/studio-preview/providerSmoke.py --runtime /prepared/runtime
"""
import argparse
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import tempfile

from prepare import verify_prepared

ROOT = Path(__file__).resolve().parents[2]


class ProviderFixture:
    def __init__(self):
        self.accepted = 0
        self.rejected = 0
        self.handlers = set()

    async def start(self):
        self.server = await asyncio.start_server(self.respond, '127.0.0.1', 0)
        self.endpoint = 'http://127.0.0.1:' + str(self.server.sockets[0].getsockname()[1]) + '/v1'

    async def respond(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            header = (await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 10)).decode()
            headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip()
                       for line in header.split('\r\n')[1:] if ':' in line}
            body = json.loads(await reader.readexactly(int(headers.get('content-length', '0'))))
            if headers.get('authorization') != 'Bearer synthetic-provider-key':
                self.rejected += 1
                response = b'{"error":{"message":"Invalid API key","type":"authentication_error"}}'
                writer.write(b'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: '
                             + str(len(response)).encode() + b'\r\nConnection: close\r\n\r\n' + response)
            else:
                self.accepted += 1
                if body['model'] != 'fixture-model':
                    raise AssertionError('Wrong selected model')
                chunks = [{'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0,
                           'model': body['model'], 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                          for delta, finish in (({'role': 'assistant', 'content': 'NATIVE_PROVIDER_FIRST_RESPONSE'}, None), ({}, 'stop'))]
                response = (''.join('data: ' + json.dumps(item) + '\n\n' for item in chunks) + 'data: [DONE]\n\n').encode()
                writer.write(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: '
                             + str(len(response)).encode() + b'\r\n\r\n' + response)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()
            self.handlers.discard(task)

    async def close(self):
        self.server.close()
        await self.server.wait_closed()
        for task in list(self.handlers):
            task.cancel()
        await asyncio.gather(*self.handlers, return_exceptions=True)


async def main(args):
    if not __debug__:
        raise RuntimeError('Run without Python -O')
    runtime = Path(args.runtime).resolve()
    receipt = verify_prepared(runtime)
    output = ROOT / '.local/studio-provider'
    output.mkdir(parents=True, exist_ok=True)
    for name in ('host.json', 'helper.json'):
        (output / name).write_text(json.dumps({'status': 'running'}) + '\n')
    binary = runtime / receipt['aioncoreBinary']
    def installed_bytes():
        return {str(p.relative_to(runtime)): hashlib.sha256(p.read_bytes()).hexdigest()
                for folder in ('native', 'adapter') for p in (runtime / folder).rglob('*')
                if p.is_file() and p.suffix != '.pyc' and '__pycache__' not in p.parts}
    before = installed_bytes()
    fixture = ProviderFixture()
    await fixture.start()
    with tempfile.TemporaryDirectory(prefix='studio-provider-') as temporary:
        sandbox = Path(temporary).resolve()
        for name in ('home', 'agent', 'workspace', 'extensions'):
            (sandbox / name).mkdir()
        # Retain realistic OS env, remove provider routing/auth variables without printing them.
        env = {k: v for k, v in os.environ.items() if not any(token in k for token in
               ('API_KEY', 'AUTH_TOKEN', 'ACCESS_TOKEN', 'BASE_URL', 'AELIX_', 'ANTHROPIC_', 'OPENAI_'))}
        env.update(HOME=str(sandbox / 'home'), AELIX_CODING_AGENT_DIR=str(sandbox / 'agent'),
                   AELIX_AUTH_PATH=str(sandbox / 'wrong-root/auth.json'), AELIX_STUDIO_RUNTIME=str(runtime),
                   PROVIDER_SANDBOX=str(sandbox), PROVIDER_ENDPOINT=fixture.endpoint, PROVIDER_OUTPUT=str(output),
                   AIONUI_BACKEND_BIN=str(binary), AIONUI_E2E_TEST='1', AIONUI_DISABLE_DEVTOOLS='1',
                   AIONUI_E2E_USER_DATA_DIR=str(sandbox / 'studio'), AIONUI_DISABLE_AUTO_UPDATE='1',
                   AIONUI_CDP_PORT='0', AIONUI_EXTENSIONS_PATH=str(sandbox / 'extensions'),
                   AIONUI_EXTENSION_STATES_FILE=str(sandbox / 'extension-states.json'))
        process = await asyncio.create_subprocess_exec('node', '--import', 'tsx',
            str(Path(__file__).with_name('providerHelperSmoke.mjs')), cwd=ROOT, env=env, start_new_session=True)
        try:
            async with asyncio.timeout(120):
                if await process.wait():
                    raise RuntimeError('Native helper qualification failed')
            process = await asyncio.create_subprocess_exec('node', '--import', 'tsx', str(Path(__file__).with_name('providerHostSmoke.mjs')),
                cwd=ROOT, env=env, start_new_session=True)
            async with asyncio.timeout(240):
                if await process.wait():
                    raise RuntimeError('Studio Provider UI qualification failed')
            if fixture.accepted < 1 or fixture.rejected < 1:
                raise AssertionError('Expected first response and rejected invalid key')
            after = installed_bytes()
            if before != after:
                raise AssertionError('Installed wheel payload changed')
            report = json.loads((output / 'host.json').read_text())
            scanned = 0
            for file in sandbox.rglob('*'):
                if file.is_file() and (file.suffix in ('.log', '.jsonl', '.db', '.sqlite', '.sqlite3') or '-wal' in file.name):
                    content = file.read_bytes()
                    if any(secret in content for secret in (b'synthetic-provider-key', b'synthetic-wrong-key')):
                        raise AssertionError('Credential sentinel found in log/transcript/database')
                    scanned += 1
            report.update(status='passed', acceptedRequests=fixture.accepted, rejectedRequests=fixture.rejected,
                          nativePatches=[], installedPayloadUnchanged=True, installedFiles=len(before),
                          realProvider=False, realOAuth=False, installer=False,
                          baselineSha256=receipt['baselineSha256'], aioncoreBinarySha256=receipt['aioncoreBinarySha256'])
            report.update(secretLogDatabaseScanFiles=scanned, secretLogDatabaseMatches=0)
            def digest(file):
                return hashlib.sha256(file.read_bytes()).hexdigest()
            sources = [Path(__file__), Path(__file__).with_name('providerHostSmoke.mjs'),
                       Path(__file__).with_name('providerHelperSmoke.mjs')]
            sources += sorted((ROOT / 'packages/web-host/src/studio-auth').glob('*.ts'))
            sources += sorted((ROOT / 'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent').glob('*.ts*'))
            sources += [ROOT / 'packages/desktop/src/index.ts', ROOT / 'packages/desktop/src/preload/main.ts',
                        ROOT / 'packages/desktop/src/process/bridge/index.ts']
            report['sourceSha256'] = {str(file.relative_to(ROOT)): digest(file) for file in sources}
            report['builtAppSha256'] = {name: digest(ROOT / name) for name in ('out/main/index.js', 'out/preload/index.js')}
            renderer = {str(file.relative_to(ROOT / 'out/renderer')): digest(file)
                        for file in sorted((ROOT / 'out/renderer').rglob('*.js'))}
            report['rendererManifestSha256'] = hashlib.sha256(json.dumps(renderer, sort_keys=True).encode()).hexdigest()
            (output / 'host.json').write_text(json.dumps(report, indent=2) + '\n')
        finally:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            await fixture.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', required=True)
    try:
        asyncio.run(main(parser.parse_args()))
    except BaseException:
        output = ROOT / '.local/studio-provider'
        output.mkdir(parents=True, exist_ok=True)
        (output / 'host.json').write_text(json.dumps({'status': 'failed'}) + '\n')
        raise
