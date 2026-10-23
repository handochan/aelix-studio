"""Exercise the patched permission bridge over real sockets without a model provider."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import platform
import secrets
import site
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[platform.machine().lower()]
RUNTIME = Path(os.environ.get('STUDIO_TEST_RUNTIME', ROOT / 'resources/bundled-aelix' / f'{sys.platform}-{arch}'))
sys.path.insert(0, str(RUNTIME / 'site'))
site.addsitedir(str(RUNTIME / 'site'))
from aelix_acp import bridge
from aelix_acp.server import Session
from aelix_acp.transport import open_permission_connection, start_permission_server


class PermissionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='studio-permission-')
        self.server = SimpleNamespace(send=self.record_update, client_request=self.answer)
        self.session = Session(self.server, 'test-session', self.tmp.name)
        self.requests = []
        self.allow = True
        self.session.permission_token = secrets.token_hex(32)
        self.listener, self.endpoint = await start_permission_server(self.session.permission, self.tmp.name, True)

    async def asyncTearDown(self):
        self.listener.close()
        await self.listener.wait_closed()
        self.tmp.cleanup()

    async def record_update(self, _update):
        return None

    async def answer(self, method, params):
        self.requests.append((method, params))
        return {'outcome': {'outcome': 'selected', 'optionId': 'allow-once' if self.allow else 'reject-once'}}

    async def request(self, token):
        reader, writer = await open_permission_connection(self.endpoint)
        writer.write((json.dumps({'token': token, 'toolCallId': 'tool-1', 'name': 'write',
                                  'args': {'path': '한글 file.txt'}}) + '\n').encode())
        await writer.drain()
        reply = json.loads(await asyncio.wait_for(reader.readline(), 2))
        writer.close()
        await writer.wait_closed()
        return reply

    async def test_listener_is_loopback_only(self):
        self.assertEqual(self.listener.sockets[0].getsockname()[0], '127.0.0.1')

    async def test_wrong_token_never_reaches_acp_client(self):
        self.assertFalse((await self.request('wrong'))['allow'])
        self.assertEqual(self.requests, [])

    async def test_missing_token_is_rejected(self):
        self.assertFalse((await self.request(''))['allow'])
        self.assertEqual(self.requests, [])

    async def test_explicit_client_consent_is_required(self):
        self.assertTrue((await self.request(self.session.permission_token))['allow'])
        self.assertEqual(self.requests[0][0], 'session/request_permission')

    async def test_rejection_blocks_the_tool(self):
        self.allow = False
        self.assertFalse((await self.request(self.session.permission_token))['allow'])

    async def test_cancelled_session_cannot_grant_permission(self):
        self.session.cancelled = True
        self.assertFalse((await self.request(self.session.permission_token))['allow'])
        self.assertEqual(self.requests, [])

    async def test_actual_extension_requests_permission_over_tcp(self):
        env = {'AELIX_ACP_SOCKET': self.endpoint, 'AELIX_ACP_PERMISSION_TOKEN': self.session.permission_token}
        event = SimpleNamespace(tool_call_id='tool-1', tool_name='write', args={'path': '한글 file.txt'})
        with patch.dict(os.environ, env):
            self.assertIsNone(await bridge.before_tool(event, None))
        self.assertEqual(len(self.requests), 1)

    async def test_large_unicode_tool_input_reaches_consent_on_each_supported_transport(self):
        for windows in ([True] if sys.platform == 'win32' else [True, False]):
            with self.subTest(tcp=windows):
                listener, endpoint = await start_permission_server(self.session.permission, self.tmp.name, windows)
                try:
                    event = SimpleNamespace(tool_call_id='large-tool', tool_name='write',
                                            args={'path': 'large.txt', 'content': '한글' * 100_000})
                    self.requests.clear()
                    with patch.dict(os.environ, {'AELIX_ACP_SOCKET': endpoint,
                                                'AELIX_ACP_PERMISSION_TOKEN': self.session.permission_token}):
                        self.assertIsNone(await bridge.before_tool(event, None))
                    self.assertEqual(len(self.requests), 1)
                finally:
                    listener.close()
                    await listener.wait_closed()

    async def test_client_failure_is_not_reported_as_a_user_rejection(self):
        async def broken_client(_method, _params):
            raise RuntimeError('client disconnected')
        self.server.client_request = broken_client
        event = SimpleNamespace(tool_call_id='tool-1', tool_name='write', args={})
        with patch.dict(os.environ, {'AELIX_ACP_SOCKET': self.endpoint,
                                    'AELIX_ACP_PERMISSION_TOKEN': self.session.permission_token}):
            result = await bridge.before_tool(event, None)
        self.assertTrue(result.block)
        self.assertIn('ACP permission unavailable', result.reason)

    async def test_broken_channel_fails_closed(self):
        event = SimpleNamespace(tool_call_id='tool-1', tool_name='write', args={})
        with patch.dict(os.environ, {'AELIX_ACP_SOCKET': 'tcp:0'}):
            self.assertTrue((await bridge.before_tool(event, None)).block)

    async def test_remote_host_is_not_an_accepted_endpoint(self):
        with self.assertRaises(ValueError):
            await open_permission_connection('tcp:example.com:443')

    @unittest.skipIf(sys.platform == 'win32', 'Unix sockets are used only on POSIX')
    async def test_posix_keeps_a_private_unix_socket(self):
        listener, endpoint = await start_permission_server(self.session.permission, self.tmp.name, False)
        try:
            self.assertEqual(Path(endpoint).stat().st_mode & 0o777, 0o600)
        finally:
            listener.close()
            await listener.wait_closed()


if __name__ == '__main__':
    unittest.main()
