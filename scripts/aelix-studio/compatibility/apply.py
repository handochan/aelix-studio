"""Apply reviewed Windows compatibility changes to the checksum-pinned ACP source.

Exact-match replacements deliberately fail when the upstream contract changes.
The original archive stays pinned; the runtime receipt includes these patch hashes.
"""
from pathlib import Path
import shutil


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise RuntimeError(f'ACP compatibility contract changed: {before[:80]!r}')
    return source.replace(before, after, 1)


def apply(package):
    package = Path(package)
    server = (package / 'server.py').read_text(encoding='utf-8')
    changes = [
        ('from . import __version__', 'from . import __version__\nfrom .transport import start_permission_server\nimport secrets'),
        ('        self.socket_server = None', '        self.socket_server = None\n        self.permission_token = secrets.token_hex(32)'),
        ('    async def permission(self, reader, writer):\n        allowed = False',
         '    async def permission(self, reader, writer):\n        allowed = False\n        channel_error = None'),
        ('        except (Exception, asyncio.CancelledError):\n            allowed = False',
         '        except (Exception, asyncio.CancelledError) as exc:\n'
         '            allowed = False\n            channel_error = type(exc).__name__'),
        ('json.dumps({"allow": allowed and not self.cancelled})',
         'json.dumps({"allow": allowed and not self.cancelled, "error": channel_error})'),
        ('        socket_path = str(Path(self.socket_dir) / "bridge.sock")\n'
         '        self.socket_server = await asyncio.start_unix_server(self.permission, path=socket_path)\n'
         '        os.chmod(socket_path, 0o600)',
         '        self.socket_server, socket_path = await start_permission_server(\n'
         '            self.permission, self.socket_dir, sys.platform == "win32")'),
        ('args = [self.server.args.aelix, "--mode"',
         'args = [self.server.args.aelix, *self.server.args.aelix_arg, "--mode"'),
        ('env = dict(os.environ, AELIX_ACP_SOCKET=socket_path, PYTHONUNBUFFERED="1",',
         'env = dict(os.environ, AELIX_ACP_SOCKET=socket_path, PYTHONUNBUFFERED="1",\n'
         '                   AELIX_ACP_PERMISSION_TOKEN=self.permission_token,'),
        ('                request = json.loads(await reader.readline())',
         '                request = json.loads(await reader.readline())\n'
         '                token = request.pop("token", "")\n'
         '                if not isinstance(token, str) or not secrets.compare_digest(token, self.permission_token):\n'
         '                    return'),
        ('        await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)',
         '        if sys.platform != "win32":\n'
         '            await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)'),
        ('        for sig in (signal.SIGTERM, signal.SIGHUP):',
         '        for sig in (() if sys.platform == "win32" else (signal.SIGTERM, signal.SIGHUP)):'),
        ('            while line := await reader.readline():',
         '            while line := await (asyncio.to_thread(sys.stdin.buffer.readline, 16 * 1024 * 1024)\n'
         '                                 if sys.platform == "win32" else reader.readline()):'),
        ('    parser.add_argument("--analytics-extension",',
         '    parser.add_argument("--aelix-arg", action="append", default=[])\n'
         '    parser.add_argument("--analytics-extension",'),
        ('    if sys.platform == "win32":\n'
         '        parser.error("The permission bridge requires Unix sockets; use macOS or Linux.")\n', ''),
        ('        if self.proc and self.proc.returncode is None:\n'
         '            self.proc.terminate()\n'
         '            try:\n'
         '                await asyncio.wait_for(self.proc.wait(), 5)\n'
         '            except TimeoutError:\n'
         '                self.proc.kill()\n'
         '                await self.proc.wait()',
         '        if self.proc and self.proc.returncode is None:\n'
         '            self.proc.stdin.close()\n'
         '            try:\n'
         '                await asyncio.wait_for(self.proc.wait(), 5)\n'
         '            except TimeoutError:\n'
         '                self.proc.terminate()\n'
         '                try:\n'
         '                    await asyncio.wait_for(self.proc.wait(), 5)\n'
         '                except TimeoutError:\n'
         '                    self.proc.kill()\n'
         '                    await self.proc.wait()'),
    ]
    for before, after in changes:
        server = replace_once(server, before, after)
    bridge = (package / 'bridge.py').read_text(encoding='utf-8')
    bridge = replace_once(bridge, 'from pathlib import Path',
                          'from pathlib import Path\nfrom aelix_acp.transport import open_permission_connection')
    bridge = replace_once(bridge, 'await asyncio.open_unix_connection(path)',
                          'await open_permission_connection(path)')
    bridge = replace_once(bridge, 'json.dumps({"toolCallId": event.tool_call_id,',
                          'json.dumps({"token": os.environ.get("AELIX_ACP_PERMISSION_TOKEN", ""),\n'
                          '                                      "toolCallId": event.tool_call_id,')
    bridge = replace_once(bridge, '            await writer.wait_closed()',
                          '            try:\n'
                          '                await writer.wait_closed()\n'
                          '            except ConnectionError:\n'
                          '                pass')
    bridge = replace_once(bridge, '        if answer.get("allow") is True:',
                          '        if not isinstance(answer, dict) or not isinstance(answer.get("allow"), bool):\n'
                          '            return ToolCallResult(block=True, reason="ACP permission channel returned an invalid response")\n'
                          '        if answer.get("error"):\n'
                          '            return ToolCallResult(block=True, reason="ACP permission unavailable: " + str(answer["error"]))\n'
                          '        if answer.get("allow") is True:')
    bridge = bridge.replace('parent owns a private Unix socket;', 'parent owns a local, authenticated permission channel;')
    (package / 'server.py').write_text(server, encoding='utf-8')
    (package / 'bridge.py').write_text(bridge, encoding='utf-8')
    shutil.copy(Path(__file__).with_name('transport.py'), package / 'transport.py')
