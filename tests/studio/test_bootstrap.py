"""Verify the real backend contract after packaging; a runtime-only job has no backend or Bun."""
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
BACKEND = ROOT/'resources/bundled-aioncore'/f'{sys.platform}-{arch}'/('aioncore.exe' if os.name == 'nt' else 'aioncore')
BUN = shutil.which('bun') or str(ROOT/'.local/toolchains/bin/bun')
AVAILABLE = BACKEND.is_file() and Path(BUN).is_file()
if os.environ.get('STUDIO_REQUIRE_HOST_TEST') == '1' and not AVAILABLE:
    raise RuntimeError('Packaged-host acceptance requires Bun and the prepared AionCore binary')


@unittest.skipUnless(AVAILABLE, 'runtime-only job: backend and Bun are validated in the desktop-package job')
class BootstrapTests(unittest.TestCase):
    def test_owned_profiles_and_team_session_through_the_real_backend(self):
        with tempfile.TemporaryDirectory(prefix='studio-bootstrap-') as tmp:
            root = Path(tmp)
            env = {k: v for k, v in os.environ.items() if not k.endswith(('API_KEY', 'AUTH_TOKEN'))}
            env.update(HOME=tmp, USERPROFILE=tmp, APPDATA=str(root/'appdata'), LOCALAPPDATA=str(root/'local'),
                       AELIX_CODING_AGENT_DIR=str(root/'agent'), AELIX_CODING_AGENT_SESSION_DIR=str(root/'sessions'),
                       UV_OFFLINE='1', PYTHONDONTWRITEBYTECODE='1')
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            with (root/'backend.log').open('w') as log:
                process = subprocess.Popen([str(BACKEND), '--local', '--host', '127.0.0.1', '--port', str(port),
                    '--data-dir', str(root/'data'), '--work-dir', str(root/'data'), '--log-dir', str(root/'logs'),
                    '--managed-resources-mode', 'bundled', '--log-level', 'error'], env=env, cwd=ROOT,
                    stdout=log, stderr=log)
                try:
                    for _ in range(100):
                        if process.poll() is not None:
                            self.fail('isolated backend exited before becoming ready')
                        try:
                            with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=1) as response:
                                if response.status == 200:
                                    break
                        except OSError:
                            pass
                        time.sleep(.1)
                    result = subprocess.run([BUN, str(ROOT/'tests/studio/runtimeBootstrap.ts'), str(port),
                        str(ROOT/'resources'), str(root/'data')], env=env, cwd=ROOT,
                        capture_output=True, text=True, encoding='utf-8', timeout=180)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertTrue(json.loads(result.stdout.splitlines()[-1])['teamSessionInitialized'])
                finally:
                    process.terminate()
                    try:
                        process.wait(10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


if __name__ == '__main__':
    unittest.main()
