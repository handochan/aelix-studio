"""Open a real ACP/Aelix session with isolated user state and no tools on PATH."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import tempfile


def verify_inventory(runtime):
    inventory = json.loads((runtime / 'checksums.json').read_text(encoding='utf-8'))
    for name, expected in inventory.items():
        path = runtime / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f'Runtime inventory mismatch: {name}')


async def smoke(runtime, temporary, profile='coding'):
    python = runtime / ('python/python.exe' if sys.platform == 'win32' else 'python/bin/python3')
    env = {**os.environ, 'HOME': str(temporary), 'USERPROFILE': str(temporary),
           'APPDATA': str(temporary / 'appdata'), 'LOCALAPPDATA': str(temporary / 'local'),
           'AELIX_CODING_AGENT_DIR': str(temporary / 'agent'),
           'AELIX_CODING_AGENT_SESSION_DIR': str(temporary / 'sessions'), 'UV_OFFLINE': '1',
           'PATH': str(temporary), 'PYTHONPATH': '/invalid', 'PYTHONHOME': '/invalid'}
    proc = await asyncio.create_subprocess_exec(
        str(python), '-I', str(runtime / 'launch.py'), 'acp', '--profile', profile,
        '--state-dir', str(temporary / f'{profile}-state'),
        cwd=temporary, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stderr_task = asyncio.create_task(proc.stderr.read())

    async def request(request_id, method, params):
        proc.stdin.write((json.dumps(dict(jsonrpc='2.0', id=request_id, method=method, params=params)) + '\n').encode())
        await proc.stdin.drain()
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), 60)
            if not line:
                raise RuntimeError((await stderr_task).decode(errors='replace'))
            result = json.loads(line)
            if result.get('id') == request_id:
                if 'error' in result:
                    raise RuntimeError(result['error'])
                return result['result']

    try:
        init = await request(1, 'initialize', dict(protocolVersion=1, clientCapabilities={},
                             clientInfo={'name': 'studio-bundle-smoke', 'version': '1'}))
        new = await request(2, 'session/new', dict(cwd=str(temporary), mcpServers=[]))
        if not new.get('sessionId'):
            raise RuntimeError('ACP did not create a session')
        print(json.dumps({'protocolVersion': init['protocolVersion'], 'agentInfo': init['agentInfo'],
                          'sessionCreated': True, 'profile': profile, 'runtime': str(runtime)}))
    finally:
        proc.stdin.close()
        try:
            await asyncio.wait_for(proc.wait(), 15)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        await stderr_task
        if proc.returncode:
            raise RuntimeError(f'ACP shutdown failed: exit {proc.returncode}')


def main():
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('runtime', nargs='?', type=Path,
                        default=Path(os.environ.get('STUDIO_PACKAGED_RUNTIME',
                            Path(__file__).resolve().parents[2] / 'resources/bundled-aelix' / f'{sys.platform}-{arch}')))
    parser.add_argument('--relocate', action='store_true')
    parser.add_argument('--profile', choices=['coding', 'analytics', 'all'], default='all')
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    with tempfile.TemporaryDirectory(prefix='studio-smoke-') as tmp:
        temporary = Path(tmp)
        if args.relocate:
            relocated = temporary / 'Aelix Studio 한글 runtime'
            shutil.copytree(runtime, relocated, symlinks=True)
            runtime = relocated
        verify_inventory(runtime)
        for profile in (['coding', 'analytics'] if args.profile == 'all' else [args.profile]):
            asyncio.run(smoke(runtime, temporary, profile))


if __name__ == '__main__':
    main()
