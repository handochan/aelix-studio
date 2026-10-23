"""Local approval transport: private Unix socket or token-authenticated loopback TCP."""
import asyncio
import os
from pathlib import Path

MAX_PERMISSION_BYTES = 16 * 1024 * 1024


async def start_permission_server(handler, directory, windows):
    if windows:
        server = await asyncio.start_server(handler, host='127.0.0.1', port=0, limit=MAX_PERMISSION_BYTES)
        return server, f'tcp:{server.sockets[0].getsockname()[1]}'
    endpoint = str(Path(directory) / 'bridge.sock')
    server = await asyncio.start_unix_server(handler, path=endpoint, limit=MAX_PERMISSION_BYTES)
    os.chmod(endpoint, 0o600)
    return server, endpoint


async def open_permission_connection(endpoint):
    if endpoint.startswith('tcp:'):
        port = endpoint.removeprefix('tcp:')
        if not port.isdecimal() or not 1 <= int(port) <= 65535:
            raise ValueError('Invalid loopback permission endpoint')
        return await asyncio.open_connection('127.0.0.1', int(port), limit=MAX_PERMISSION_BYTES)
    return await asyncio.open_unix_connection(endpoint, limit=MAX_PERMISSION_BYTES)
