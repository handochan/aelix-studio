"""Qualify Provider registration against unchanged native wheels and the actual Studio UI.

Uses a disposable HOME and a local synthetic provider, never operator credentials.
Run after building Studio: python3 scripts/studio-preview/providerSmoke.py --runtime /prepared/runtime
"""
import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import time
from urllib.parse import quote
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
FORK_PARENT = 'SYNTHETIC_HEAD_FORK_PARENT'
FORK_CHILD = 'SYNTHETIC_HEAD_FORK_CHILD'
FORK_RESTART = 'SYNTHETIC_HEAD_FORK_RESTART'
# The UI flow's provider calls: fork parent, fork child, restarted child and the LAN
# WebUI reply succeed; the first wrong key is the only rejection. The unreachable
# endpoint must not reach the fixture at all, so any other count is an unrelated failure.
EXPECTED_ACCEPTED_REQUESTS = 4
EXPECTED_REJECTED_REQUESTS = 1
OFFLINE_ACCEPTED_REQUESTS = 1

def phase_timeout(deadline, limit):
    """Bound each phase by both its own limit and the shared deadline."""
    return min(limit, max(0, deadline - time.monotonic()))


def provider_host_timeout(deadline, target):
    """Allow extra Provider UI time on macOS Intel within the shared deadline."""
    # On the Intel runner, passing UI runs took up to 225s and slower runs
    # exhausted 240s before the full desktop and LAN flow could finish (#107).
    return phase_timeout(deadline, 300 if target == 'darwin-x64' else 240)


@contextlib.contextmanager
def provider_sandbox():
    """Keep a UI failure primary when a leftover process races sandbox cleanup."""
    temporary = tempfile.TemporaryDirectory(prefix='Studio Provider user 한글-')
    try:
        yield Path(temporary.name).resolve()
    except BaseException as failure:
        try:
            temporary.cleanup()
        except OSError as cleanup_error:
            failure.add_note(f'Provider sandbox cleanup failed: {cleanup_error}')
        raise
    else:
        temporary.cleanup()


def verify_fork_bindings(root, parent_id, child_id):
    root = root.resolve()
    databases = list(root.rglob('aionui-backend.db'))
    if len(databases) != 1 or not databases[0].resolve().is_relative_to(root):
        raise AssertionError('Expected one isolated host database for the displayed fork')
    with contextlib.closing(sqlite3.connect(f'{databases[0].as_uri()}?mode=ro', uri=True)) as db:
        bindings = dict(db.execute('SELECT conversation_id, session_id FROM acp_session '
                                   'WHERE conversation_id IN (?, ?)', (parent_id, child_id)))
    if len(bindings) != 2 or not all(bindings.values()) or len(set(bindings.values())) != 2:
        raise AssertionError('Displayed parent and child need distinct stored ACP session IDs')
    return bindings


def read_fork_identity(root, parent_id, child_id):
    root = root.resolve()
    bindings = verify_fork_bindings(root, parent_id, child_id)
    store = (root / 'acp/sessions.sqlite3').resolve(strict=True)
    if not store.is_relative_to(root):
        raise AssertionError('ACP store escaped the isolated profile')
    parent_acp, child_acp = bindings[parent_id], bindings[child_id]
    with contextlib.closing(sqlite3.connect(f'{store.as_uri()}?mode=ro', uri=True)) as db:
        files = dict(db.execute('SELECT id, file FROM sessions WHERE id IN (?, ?)', (parent_acp, child_acp)))
    parent_file, child_file = (Path(files[id]).resolve(strict=True) for id in (parent_acp, child_acp))
    if not all(file.is_relative_to(root) for file in (parent_file, child_file)) or parent_file == child_file:
        raise AssertionError('Expected distinct native session files in the isolated profile')
    with parent_file.open(encoding='utf-8') as parent, child_file.open(encoding='utf-8') as child:
        parent_header, child_header = json.loads(parent.readline()), json.loads(child.readline())
    parent_native, child_native = (str(UUID(header['id'])) for header in (parent_header, child_header))
    if child_native == parent_native or Path(child_header['parentSession']).resolve(strict=True) != parent_file:
        raise AssertionError('Expected a distinct native child with the original parent link')
    return dict(parentAcpId=parent_acp, childAcpId=child_acp, nativeChildId=child_native,
                nativeChildFile=child_file.relative_to(root).as_posix())


def verify_restarted_fork(root, parent_id, child_id, before):
    observed = read_fork_identity(root, parent_id, child_id)
    if observed != before:
        changed = ', '.join(key for key, value in observed.items() if before.get(key) != value)
        raise AssertionError(f'Cold restart changed the persisted ACP or native child identity ({changed})')


def read_provider_report(root, file):
    # Node writes UTF-8, including any Unicode in the native child path.
    report = json.loads(file.read_text(encoding='utf-8'))
    fork = report.pop('headFork')
    verify_restarted_fork(root, fork['parentId'], fork['childId'], fork['beforeRestart'])
    return report


class ProviderFixture:
    def __init__(self):
        self.accepted = 0
        self.rejected = 0
        self.handlers = set()
        self.fork_contexts = {FORK_CHILD: [], FORK_RESTART: []}

    def observe_fork_context(self, messages):
        if not messages:
            return
        prompt = json.dumps(messages[-1])
        for marker, contexts in self.fork_contexts.items():
            if marker in prompt:
                history = json.dumps(messages[:-1])
                contexts.append(tuple(value for value in (FORK_PARENT, FORK_CHILD) if value in history))

    def verify_fork_context(self):
        if self.fork_contexts != {FORK_CHILD: [(FORK_PARENT,)], FORK_RESTART: [(FORK_PARENT, FORK_CHILD)]}:
            raise AssertionError('The model did not receive the displayed parent and continued child context')

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
                self.observe_fork_context(body.get('messages'))
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


def provider_environment(sandbox, output, endpoint, helper_runtime, binary, *, offline_mode):
    for name in ('home', 'agent', 'workspace', 'extensions'):
        (sandbox / name).mkdir()
    config = sandbox / 'studio/config/aionui-config.txt'
    config.parent.mkdir(parents=True, exist_ok=True)
    preferences = {'update.autoCheck': False, 'network.offlineMode': offline_mode}
    config.write_text(base64.b64encode(quote(json.dumps(preferences), safe='').encode()).decode())
    # Bound only the synthetic transport failure: native and SDK defaults
    # can otherwise keep Windows' closed-port probe retrying beyond the UI assertion.
    settings = sandbox / 'agent/settings.json'
    settings.write_text(json.dumps({'retry': {'enabled': False, 'provider': {'timeoutMs': 5000, 'maxRetries': 0}}}))
    # Retain realistic OS env, remove provider routing/auth variables without printing them.
    env = {k: v for k, v in os.environ.items() if not any(token in k for token in
           ('API_KEY', 'AUTH_TOKEN', 'ACCESS_TOKEN', 'BASE_URL', 'AELIX_', 'ANTHROPIC_', 'OPENAI_',
            'AWS_', 'GOOGLE_', 'GEMINI_', 'AZURE_', 'OPENROUTER_', 'PROXY'))}
    env.update(HOME=str(sandbox / 'home'), AELIX_CODING_AGENT_DIR=str(sandbox / 'agent'),
               AELIX_ACP_STATE_DIR=str(sandbox / 'acp'),
               AELIX_SETTINGS_PATH=str(settings),
               USERPROFILE=str(sandbox / 'home'), CFFIXED_USER_HOME=str(sandbox / 'home'),
               NO_PROXY='127.0.0.1,localhost',
               XDG_CONFIG_HOME=str(sandbox / 'home/config'), XDG_CACHE_HOME=str(sandbox / 'home/cache'),
               APPDATA=str(sandbox / 'home/appdata'), LOCALAPPDATA=str(sandbox / 'home/localappdata'),
               AELIX_AUTH_PATH=str(sandbox / 'wrong-root/auth.json'), AELIX_STUDIO_RUNTIME=str(helper_runtime),
               PROVIDER_SANDBOX=str(sandbox), PROVIDER_ENDPOINT=endpoint, PROVIDER_OUTPUT=str(output),
               AIONUI_BACKEND_BIN=str(binary), AIONUI_E2E_TEST='1', AIONUI_DISABLE_DEVTOOLS='1',
               AIONUI_E2E_USER_DATA_DIR=str(sandbox / 'studio'),
               AIONUI_CDP_PORT='0', AIONUI_EXTENSIONS_PATH=str(sandbox / 'extensions'),
               AIONUI_EXTENSION_STATES_FILE=str(sandbox / 'extension-states.json'))
    return env


def scan_provider_logs(sandbox):
    scanned = 0
    for file in sandbox.rglob('*'):
        if file.is_file() and (file.suffix in ('.log', '.jsonl', '.db', '.sqlite', '.sqlite3') or '-wal' in file.name):
            content = file.read_bytes()
            if any(secret in content for secret in (b'synthetic-provider-key', b'synthetic-wrong-key')):
                raise AssertionError('Credential sentinel found in log/transcript/database')
            scanned += 1
    return scanned


async def run_provider_driver(script, env, timeout, phase):
    if timeout <= 0:
        raise TimeoutError(f'Provider capture deadline expired before {phase}')
    start = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        'node', '--import', 'tsx', str(Path(__file__).with_name(script)), cwd=ROOT, env=env,
        **({'start_new_session': True} if os.name != 'nt' else {}))
    try:
        async with asyncio.timeout(timeout):
            if await process.wait():
                raise RuntimeError(f'Studio qualification failed: {phase}')
    finally:
        print(json.dumps({'wait': phase, 'timeoutSeconds': timeout,
                          'elapsedSeconds': round(time.monotonic() - start, 3)}), flush=True)
        if process.returncode is None:
            if os.name == 'nt':
                cleanup = await asyncio.create_subprocess_exec('taskkill', '/PID', str(process.pid), '/T', '/F',
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await cleanup.wait()
            else:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(process.wait(), 5)
            except TimeoutError:
                if os.name == 'nt':
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                await process.wait()


async def qualify_offline_provider(output, helper_runtime, binary, deadline):
    # The LAN check and this check never share a Studio profile, backend or provider fixture.
    fixture = ProviderFixture()
    await fixture.start()
    receipt = output / 'offline-host.json'
    try:
        with provider_sandbox() as sandbox:
            env = provider_environment(sandbox, output, fixture.endpoint, helper_runtime, binary, offline_mode=True)
            await run_provider_driver(
                'providerHostSmoke.mjs', dict(env, PROVIDER_DRIVER_PYTHON=sys.executable,
                                              STUDIO_PROVIDER_SCENARIO='offline-provider'),
                phase_timeout(deadline, 120), 'offline-provider-ui')
            if (fixture.accepted, fixture.rejected) != (OFFLINE_ACCEPTED_REQUESTS, 0):
                raise AssertionError('Expected one accepted provider reply and zero rejections in offline mode')
            report = json.loads(receipt.read_text(encoding='utf-8'))
            if report.get('offlineMode') is not True:
                raise AssertionError('Missing proof that the accepted provider reply was in offline mode')
            report.update(status='passed', acceptedRequests=fixture.accepted, rejectedRequests=fixture.rejected,
                          secretLogDatabaseScanFiles=scan_provider_logs(sandbox), secretLogDatabaseMatches=0)
            receipt.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            return report
    except Exception as error:
        receipt.write_text(json.dumps({
            'status': 'failed', 'offlineMode': True, 'errorKind': type(error).__name__,
            'acceptedRequests': fixture.accepted, 'rejectedRequests': fixture.rejected,
        }, indent=2) + '\n', encoding='utf-8')
        raise
    finally:
        await fixture.close()


async def main(args):
    include_offline = os.environ.get('STUDIO_PROVIDER_OFFLINE_MODE') == '1'
    output = ROOT / '.local/studio-provider'
    output.mkdir(parents=True, exist_ok=True)
    for name in ('first-window.json', 'offline-first-window.json', 'offline-host.json'):
        (output / name).unlink(missing_ok=True)
    for name in ('host.json', 'helper.json'):
        (output / name).write_text(json.dumps({'status': 'running'}) + '\n')
    from prepare import verify_prepared

    if not __debug__:
        raise RuntimeError('Run without Python -O')
    runtime = Path(args.runtime).resolve()
    receipt = verify_prepared(runtime)
    helper_runtime = Path(args.helper_runtime).resolve() if args.helper_runtime else runtime
    helper_manifest = None
    if args.helper_runtime:
        helper_manifest = json.loads((helper_runtime / 'manifest.json').read_text(encoding='utf-8'))
        if (helper_manifest.get('schema') != 'aelix.studio-preview.runtime/1'
                or helper_manifest.get('target') != receipt['target']
                or helper_manifest.get('baselineSha256') != receipt['baselineSha256']
                or helper_manifest.get('preparedReceiptSha256') != hashlib.sha256((runtime / 'receipt.json').read_bytes()).hexdigest()
                or helper_manifest.get('nativePatches') != []
                or helper_manifest.get('native') != receipt['native']
                or helper_manifest.get('acp') != receipt['acp']):
            raise ValueError('Selected bundled helper differs from the qualified preparation')
    binary = runtime / receipt['aioncoreBinary']
    def installed_bytes():
        return {str(p.relative_to(runtime)): hashlib.sha256(p.read_bytes()).hexdigest()
                for folder in ('native', 'adapter') for p in (runtime / folder).rglob('*')
                if p.is_file() and p.suffix != '.pyc' and '__pycache__' not in p.parts}
    before = installed_bytes()
    def helper_bytes():
        return {p.relative_to(helper_runtime).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in helper_runtime.rglob('*') if p.is_file()}
    bundled_before = helper_bytes() if helper_manifest else None
    fixture = ProviderFixture()
    await fixture.start()
    with provider_sandbox() as sandbox:
        env = provider_environment(sandbox, output, fixture.endpoint, helper_runtime, binary, offline_mode=False)
        offline_task = None
        try:
            # Reserve 30s of the 480s capture for attach/drain and receipt work.
            qualification_deadline = time.monotonic() + 450
            # The short, separately isolated Desktop turn can run alongside the
            # native helper probes so LAN keeps its existing UI time budget.
            if include_offline:
                offline_task = asyncio.create_task(qualify_offline_provider(
                    output, helper_runtime, binary, qualification_deadline))
            await run_provider_driver(
                'providerHelperSmoke.mjs', env, phase_timeout(qualification_deadline, 300), 'helper-qualification')
            host_timeout = provider_host_timeout(qualification_deadline, receipt['target'])
            await run_provider_driver('providerHostSmoke.mjs', dict(
                env, PROVIDER_DRIVER_PYTHON=sys.executable, STUDIO_PROVIDER_SCENARIO='online-ui'),
                host_timeout, 'online-provider-ui')
            if (fixture.accepted, fixture.rejected) != (EXPECTED_ACCEPTED_REQUESTS, EXPECTED_REJECTED_REQUESTS):
                raise AssertionError(f'Expected {EXPECTED_ACCEPTED_REQUESTS} provider replies and '
                                     f'{EXPECTED_REJECTED_REQUESTS} rejected key, got {fixture.accepted} and '
                                     f'{fixture.rejected}')
            offline_report = None
            offline_error = None
            if offline_task:
                try:
                    offline_report = await offline_task
                except Exception as error:
                    offline_error = error
                    offline_report = dict(status='failed', offlineMode=True, errorKind=type(error).__name__)
            after = installed_bytes()
            if before != after:
                raise AssertionError('Installed wheel payload changed')
            if helper_manifest and bundled_before != helper_bytes():
                raise AssertionError('Installed bundled helper payload changed')
            report = read_provider_report(sandbox, output / 'host.json')
            fixture.verify_fork_context()
            report['checks'] += ['native_head_fork_distinct_stored_acp_bindings',
                                 'native_head_fork_same_acp_and_native_child', 'native_head_fork_model_context']
            scanned = scan_provider_logs(sandbox)
            report.update(status='failed' if offline_error else 'passed',
                          acceptedRequests=fixture.accepted, rejectedRequests=fixture.rejected,
                          nativePatches=[], installedPayloadUnchanged=True, installedFiles=len(before),
                          realProvider=False, realOAuth=False, offlineMode=False,
                          installer=bool(os.environ.get('PROVIDER_APP_EXECUTABLE')),
                          baselineSha256=receipt['baselineSha256'], aioncoreBinarySha256=receipt['aioncoreBinarySha256'])
            if offline_report:
                report['onlineProvider'] = dict(status='passed', offlineMode=False,
                                                acceptedRequests=fixture.accepted, rejectedRequests=fixture.rejected)
                report['offlineProvider'] = offline_report
            report.update(helperRuntimeKind='bundled' if helper_manifest else 'prepared',
                          helperRuntimeManifestSha256=(hashlib.sha256((helper_runtime / 'manifest.json').read_bytes()).hexdigest()
                                                       if helper_manifest else None),
                          helperRuntimePayloadUnchanged=True if helper_manifest else None, helperRuntimeFiles=len(bundled_before or before))
            report.update(secretLogDatabaseScanFiles=scanned, secretLogDatabaseMatches=0)
            def digest(file):
                return hashlib.sha256(file.read_bytes()).hexdigest()
            sources = [Path(__file__), Path(__file__).with_name('providerHostSmoke.mjs'),
                       Path(__file__).with_name('providerHelperSmoke.mjs'),
                       Path(__file__).with_name('host-release') / 'verification.mjs']
            sources += sorted((ROOT / 'packages/web-host/src/studio-auth').glob('*.ts'))
            sources += sorted((ROOT / 'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent').glob('*.ts*'))
            sources += [ROOT / 'packages/desktop/src/renderer/services/runtime/nativeAuth.ts',
                        ROOT / 'packages/desktop/src/index.ts', ROOT / 'packages/desktop/src/preload/main.ts',
                        ROOT / 'packages/desktop/src/process/bridge/index.ts']
            report['sourceSha256'] = {file.relative_to(ROOT).as_posix(): digest(file) for file in sources}
            report['builtAppSha256'] = {name: digest(ROOT / name) for name in ('out/main/index.js', 'out/preload/index.js')}
            renderer = {file.relative_to(ROOT / 'out/renderer').as_posix(): digest(file)
                        for file in sorted((ROOT / 'out/renderer').rglob('*.js'))}
            report['rendererManifestSha256'] = hashlib.sha256(json.dumps(renderer, sort_keys=True).encode()).hexdigest()
            (output / 'host.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
            if offline_error:
                raise offline_error
        finally:
            if offline_task:
                await asyncio.gather(offline_task, return_exceptions=True)
            await fixture.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--runtime')
    mode.add_argument('--read-fork-identity', nargs=3, metavar=('PROFILE', 'PARENT', 'CHILD'))
    parser.add_argument('--helper-runtime', help='Installed bundled payload; the prepared runtime still supplies provenance')
    args = parser.parse_args()
    if args.read_fork_identity:
        root, parent_id, child_id = args.read_fork_identity
        print(json.dumps(read_fork_identity(Path(root), parent_id, child_id)))
        sys.exit(0)
    try:
        asyncio.run(main(args))
    except BaseException:
        output = ROOT / '.local/studio-provider'
        output.mkdir(parents=True, exist_ok=True)
        for name in ('host.json', 'helper.json'):
            file = output / name
            completed = json.loads(file.read_text(encoding='utf-8')) if file.exists() else {}
            if completed.get('status') != 'passed':
                file.write_text(json.dumps({'status': 'failed'}) + '\n')
        raise
