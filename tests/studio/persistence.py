"""Record and restore a real ACP session across two disposable Docker containers."""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import platform
import sqlite3
import sys


async def restore_session(runtime, state, session):
    process = await asyncio.create_subprocess_exec(sys.executable, '-I', str(runtime/'launch.py'), 'acp',
        '--profile', 'coding', '--state-dir', str(state), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    errors = asyncio.create_task(process.stderr.read())
    try:
        for number, method, params in [(1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {}}),
                (2, 'session/load', {'sessionId': session['id'], 'cwd': session['cwd'], 'mcpServers': []})]:
            process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': number, 'method': method, 'params': params})+'\n').encode())
            await process.stdin.drain()
            while True:
                line = await asyncio.wait_for(process.stdout.readline(), 60)
                if not line:
                    raise RuntimeError('ACP closed before restoring the persisted session')
                response = json.loads(line)
                if response.get('id') == number:
                    if 'error' in response:
                        raise RuntimeError(response['error'])
                    break
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 15)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        stderr = await errors
        if process.returncode:
            raise RuntimeError(f'ACP restore failed: {stderr.decode(errors="replace")}')


def main():
    if os.environ.get('STUDIO_PERSISTENCE_TEST') != '1':
        raise SystemExit('Run this check only with STUDIO_PERSISTENCE_TEST=1 and a disposable data volume.')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['record', 'restore'])
    args = parser.parse_args()
    data = Path(os.environ['AIONUI_DATA_DIR']).resolve()
    agent = Path(os.environ['AELIX_CODING_AGENT_DIR']).resolve()
    sessions = Path(os.environ['AELIX_CODING_AGENT_SESSION_DIR']).resolve()
    if not agent.is_relative_to(data) or not sessions.is_relative_to(data):
        raise RuntimeError('Aelix settings and sessions must reside on the data volume')
    marker = data/'studio-persistence-test.json'
    setting = agent/'studio-persistence-test.json'
    if args.mode == 'record':
        with sqlite3.connect(f'file:{data}/aelix-acp/sessions.sqlite3?mode=ro', uri=True) as db:
            row = db.execute("SELECT id,cwd,file FROM sessions WHERE profile='coding' AND file IS NOT NULL ORDER BY updated DESC LIMIT 1").fetchone()
        if row is None or not Path(row[2]).resolve().is_relative_to(sessions):
            raise RuntimeError('No real Aelix session file was persisted on the volume')
        agent.mkdir(parents=True, exist_ok=True)
        setting.write_text('{"fixture":"retained"}\n')
        marker.write_text(json.dumps({'id': row[0], 'cwd': row[1], 'file': row[2],
            'sha256': hashlib.sha256(Path(row[2]).read_bytes()).hexdigest()}))
        print(json.dumps({'sessionRecorded': True, 'settingsOnVolume': True}))
    else:
        session = json.loads(marker.read_text())
        if json.loads(setting.read_text()) != {'fixture': 'retained'}:
            raise RuntimeError('Settings were lost during container replacement')
        if hashlib.sha256(Path(session['file']).read_bytes()).hexdigest() != session['sha256']:
            raise RuntimeError('The original session file was lost or changed')
        arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
        runtime = Path(__file__).resolve().parents[2]/'resources/bundled-aelix'/f'{sys.platform}-{arch}'
        asyncio.run(restore_session(runtime, data/'aelix-acp', session))
        print(json.dumps({'sessionRestored': True, 'settingsRetained': True}))


if __name__ == '__main__':
    main()
