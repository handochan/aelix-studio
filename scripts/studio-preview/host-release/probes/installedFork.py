"""Read the installed fixture's binding and observe its ACP fork response."""
import contextlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading


def observe_binding(root, conversation_id):
    root = root.resolve()
    matches = []
    for file in root.rglob('aionui-backend.db'):
        if not file.resolve().is_relative_to(root):
            raise ValueError('The installed fixture database escaped the isolated root')
        with contextlib.closing(sqlite3.connect(f'{file.as_uri()}?mode=ro', uri=True)) as db:
            present = db.execute("SELECT 1 FROM sqlite_master WHERE name = 'acp_session'").fetchone()
            if present:
                row = db.execute('SELECT session_id FROM acp_session WHERE conversation_id = ?',
                                 (conversation_id,)).fetchone()
                if row is not None:
                    matches.append(row[0])
    if len(matches) > 1:
        raise ValueError('The installed fixture contains multiple ACP bindings for the same conversation')
    return {'found': bool(matches), 'sessionId': matches[0] if matches else None}


def record_fork_wire(path, command):
    # Relay the real installed adapter and record only the fork response code
    # and kind. The released host intentionally hides that detail in HTTP 502.
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    pending = set()

    def relay_responses():
        with child.stdout, path.open('a', encoding='utf-8') as log:
            for line in child.stdout:
                with contextlib.suppress(ValueError):
                    frame = json.loads(line)
                    if isinstance(frame, dict) and frame.get('id') in pending and 'method' not in frame:
                        pending.remove(frame['id'])
                        error = frame.get('error') or {}
                        details = error.get('data') or {}
                        log.write(json.dumps({'code': error.get('code'), 'kind': details.get('kind')}) + '\n')
                        log.flush()
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
        sys.stdout.buffer.close()

    reader = threading.Thread(target=relay_responses, daemon=True)
    reader.start()
    try:
        with child.stdin:
            for line in sys.stdin.buffer:
                with contextlib.suppress(ValueError):
                    frame = json.loads(line)
                    if isinstance(frame, dict) and frame.get('method') == 'session/fork' and 'id' in frame:
                        pending.add(frame['id'])
                child.stdin.write(line)
                child.stdin.flush()
    finally:
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        reader.join(timeout=5)
    return child.returncode


if __name__ == '__main__':
    if sys.argv[1] == 'observe':
        request = json.load(sys.stdin)
        print(json.dumps(observe_binding(Path(request['root']), request['conversationId'])))
    elif sys.argv[1] == 'record':
        raise SystemExit(record_fork_wire(Path(sys.argv[2]), sys.argv[3:]))
