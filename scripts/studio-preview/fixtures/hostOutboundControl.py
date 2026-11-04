"""Positive control: an actual installed host launches a TEST-NET TCP/UDP child.

The caller must create a private network namespace with only loopback enabled.
No packets can reach an external interface; the auditor must still detect intent.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


def wait_for_child_cleanup(pid, timeout=15):
    """Let the control host finish its own runtime probes before termination."""
    deadline, quiet_since = time.monotonic() + timeout, None
    while time.monotonic() < deadline:
        children = []
        for task in Path(f'/proc/{pid}/task').iterdir():
            try:
                children.extend((task / 'children').read_text().split())
            except FileNotFoundError:
                # A task exited during the sample; require a fresh quiet interval.
                children.append('resample')
        if children:
            quiet_since = None
        elif quiet_since is None:
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= 1:
            return
        time.sleep(0.05)
    raise TimeoutError('Control host child cleanup did not settle')


def child(marker):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from outboundAudit import positive_control
    positive_control()
    marker.write_text(json.dumps({'pid': os.getpid()}) + '\n')
    # Complete a tiny real MCP handshake so the host need not diagnose a
    # deliberately broken protocol. Exit after listing tools, before cleanup.
    for line in sys.stdin:
        request = json.loads(line)
        if 'id' not in request: continue
        if request['method'] == 'initialize':
            result = {'protocolVersion': request['params']['protocolVersion'], 'capabilities': {'tools': {}},
                      'serverInfo': {'name': 'synthetic-outbound-control', 'version': '1'}}
        elif request['method'] == 'tools/list':
            result = {'tools': []}
        else:
            raise AssertionError('Unexpected control MCP request')
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
        if request['method'] == 'tools/list': return


def run(core, native, receipt, parent_namespace):
    namespace = os.readlink('/proc/self/ns/net')
    assert namespace != parent_namespace, 'A fresh network namespace is required'
    assert {name for _, name in socket.if_nameindex()} == {'lo'}, 'Only loopback may exist'
    assert json.loads(subprocess.check_output(['ip', '-j', 'route', 'show', 'default'])) == []
    assert json.loads(subprocess.check_output(['ip', '-j', '-6', 'route', 'show', 'default'])) == []
    with tempfile.TemporaryDirectory(prefix='studio-host-outbound-control-') as directory:
        root = Path(directory)
        (root / 'extensions').mkdir()
        env = dict(os.environ, HOME=str(root), USERPROFILE=str(root),
                   AIONUI_EXTENSIONS_PATH=str(root / 'extensions'),
                   AIONUI_EXTENSION_STATES_FILE=str(root / 'extension-states.json'),
                   AIONUI_BUNDLED_MANAGED_RESOURCES=str(core.parent / 'managed-resources'),
                   AELIX_STUDIO_HOST_UPDATE_CHECK='', AELIX_STUDIO_HOST_NODE_MIRROR='',
                   AELIX_STUDIO_HOST_NPM_REGISTRY='', AELIX_STUDIO_HOST_REMOTE_IMAGES='')
        log = root / 'host.log'
        marker = root / 'child.json'
        with log.open('wb') as stream:
            host = subprocess.Popen([str(core), '--local', '--port', '0', '--data-dir', str(root / 'data'),
                                     '--managed-resources-mode', 'bundled', '--log-level', 'info'],
                                    env=env, stdout=stream, stderr=subprocess.STDOUT)
            try:
                port, ready = None, False
                deadline = time.monotonic() + 45
                while time.monotonic() < deadline:
                    if host.poll() is not None: raise RuntimeError('Control host exited before readiness')
                    for line in log.read_text(errors='replace').splitlines():
                        if line.startswith('AIONCORE_LISTENING '):
                            value = json.loads(line.split(' ', 1)[1])
                            assert value['host'] == '127.0.0.1'
                            port = value['port']
                    ready = 'AIONCORE_READY' in log.read_text(errors='replace').splitlines()
                    if port is not None and ready: break
                    time.sleep(0.05)
                if port is None or not ready: raise TimeoutError('Control host readiness timed out')
                # Complete bundled runtime validation before shutdown so a
                # cancelled startup exec cannot masquerade as a complete trace.
                prepare = urllib.request.Request(f'http://127.0.0.1:{port}/api/system/ensure-node-runtime',
                    data=b'{"scope":{"kind":"mcp","id":"synthetic-outbound-control"}}',
                    headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(prepare, timeout=45) as response:
                    assert response.status == 200
                wait_for_child_cleanup(host.pid)
                body = {'name': 'synthetic-outbound-control', 'transport': {
                    'type': 'stdio', 'command': str(native),
                    'args': ['-I', '-B', str(Path(__file__).resolve()), '--child', str(marker)], 'env': {}}}
                request = urllib.request.Request(f'http://127.0.0.1:{port}/api/mcp/test-connection',
                                                 data=json.dumps(body).encode(),
                                                 headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=30) as response:
                    assert response.status == 200, 'The synthetic MCP handshake must complete'
                child_pid = json.loads(marker.read_text())['pid']
                wait_for_child_cleanup(host.pid)
            finally:
                host.terminate()
                try:
                    host.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    host.kill(); host.wait()
            assert host.returncode == 0, 'Control host must shut down gracefully'
        receipt.write_text(json.dumps({'schema': 'aelix.host-tree-control/1', 'status': 'passed',
            'privateNetworkNamespace': True, 'onlyLoopbackInterface': True, 'defaultRoutes': 0,
            'hostPid': host.pid, 'childPid': child_pid, 'hostExitCode': host.returncode}) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--child', type=Path)
    parser.add_argument('--host', type=Path)
    parser.add_argument('--native', type=Path)
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--parent-namespace')
    args = parser.parse_args()
    if args.child:
        child(args.child)
    else:
        run(args.host.resolve(), args.native.resolve(), args.receipt.resolve(), args.parent_namespace)
