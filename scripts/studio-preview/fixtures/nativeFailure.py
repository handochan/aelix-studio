"""Transparent native stdio relay with a test-only fail-start downgrade fault.

No frames or permission replies are synthesized. The fault closes the real native
worker after ACP has saved Ask but before its permissions/set RPC is delivered.
"""
import json
from pathlib import Path
import subprocess
import sys
import threading


def run(root, payload, extension, arguments):
    """Run the installed native CLI, failing startup/downgrade only under the marker."""
    marker = root / 'fail-start'
    if marker.exists():
        mode = arguments[arguments.index('--permission-mode')+1] if '--permission-mode' in arguments else None
        (root / 'startup-fault.json').write_text(json.dumps({'nativeStarted': False, 'mode': mode}))
        raise SystemExit(73)
    child = subprocess.Popen([sys.executable, '-I', '-S', '-B', '-X', 'utf8',
                              str(payload / 'launch.py'), 'native', *arguments,
                              '-e', str(extension)], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=None)

    def forward_output():
        for line in child.stdout:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()

    output = threading.Thread(target=forward_output, daemon=True)
    output.start()
    fault = False
    try:
        for line in sys.stdin.buffer:
            try:
                frame = json.loads(line)
            except ValueError:
                frame = {}
            if (marker.exists() and frame.get('type') == 'aelix_control'
                    and frame.get('method') == 'permissions/set'
                    and (frame.get('params') or {}).get('mode') == 'default'):
                (root / 'downgrade-fault.json').write_text(json.dumps({
                    'nativePid': child.pid, 'command': 'permissions/set', 'mode': 'default',
                    'forwarded': False,
                }))
                fault = True
                break
            child.stdin.write(line)
            child.stdin.flush()
    finally:
        child.stdin.close()
        if fault and child.poll() is None:
            child.terminate()
        try:
            code = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            code = child.wait(timeout=5)
        output.join(timeout=5)
    raise SystemExit(73 if fault else code)
