import http, { type OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { readSourceHeaders } from './requestOrigin.js';

const UPGRADE_HEADERS = new Set([
  'host',
  'origin',
  'sec-fetch-site',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'cookie',
  'authorization',
]);

export const MAX_UPGRADE_HEADER_BYTES = 16 * 1024;

export function requestLineTargetsWebSocket(line: string): boolean {
  return /^GET \/(?:ws|api\/stt\/stream)(?:\?[\x21-\x7e]*)? HTTP\/1\.1\r?$/.test(line);
}

export function rejectSocket(client: Socket, status: number): void {
  if (client.destroyed || client.writableEnded) return;
  client.end(
    ['HTTP/1.1 ' + status + ' ' + http.STATUS_CODES[status], 'Connection: close', 'Content-Length: 0', '\r\n'].join(
      '\r\n'
    )
  );
}

function parseUpgrade(requestHead: string) {
  const [requestLine, ...lines] = requestHead.split('\r\n');
  if (!requestLineTargetsWebSocket(requestLine)) return undefined;
  const path = requestLine.split(' ')[1];
  const headers: Record<string, string> = {};
  let hasContentLength = false;
  for (const line of lines) {
    const field = /^([!#$%&'*+.^_\x60|~0-9a-z-]+):[ \t]*([\x20-\x7e\t]*)$/i.exec(line);
    if (!field) return undefined;
    const name = field[1].toLowerCase();
    if (name === 'transfer-encoding') return undefined;
    if (name === 'content-length') {
      if (hasContentLength || field[2].trim() !== '0') return undefined;
      hasContentLength = true;
      continue;
    }
    if (!UPGRADE_HEADERS.has(name)) continue;
    if (Object.hasOwn(headers, name)) return undefined;
    headers[name] = field[2].trim();
  }
  if (
    headers.upgrade?.toLowerCase() !== 'websocket' ||
    !headers.connection
      ?.toLowerCase()
      .split(',')
      .some((token) => token.trim() === 'upgrade') ||
    headers['sec-websocket-version'] !== '13' ||
    !/^[a-z\d+/]{22}==$/i.test(headers['sec-websocket-key'] ?? '')
  ) {
    return undefined;
  }
  return { path, headers };
}

/** Forward just the checked handshake. Relay socket bytes after an upstream 101. */
export function proxyWebSocket(
  client: Socket,
  requestHead: string,
  backendPort: number,
  isAllowed: (source: ReturnType<typeof readSourceHeaders>, requireOrigin: boolean) => boolean
): void {
  const upgrade = parseUpgrade(requestHead);
  if (!upgrade) {
    rejectSocket(client, 400);
    return;
  }
  if (!isAllowed(readSourceHeaders(Object.entries(upgrade.headers).flat()), true)) {
    rejectSocket(client, 403);
    return;
  }

  client.pause();
  const host = '127.0.0.1:' + backendPort;
  const headers: OutgoingHttpHeaders = { ...upgrade.headers, host, origin: 'http://' + host, connection: 'Upgrade' };

  const proxy = http.request({ hostname: '127.0.0.1', port: backendPort, path: upgrade.path, headers });
  const closeProxy = () => proxy.destroy();
  client.once('close', closeProxy);
  proxy.setTimeout(5000, closeProxy);
  proxy.once('error', () => rejectSocket(client, 502));
  proxy.once('response', (response) => {
    response.destroy();
    rejectSocket(client, response.statusCode ?? 502);
  });
  proxy.once('upgrade', (response, upstream, head) => {
    if (response.statusCode !== 101 || client.destroyed) {
      upstream.destroy();
      client.destroy();
      return;
    }
    client.off('close', closeProxy);
    upstream.setTimeout(0);
    const fields: string[] = [];
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      fields.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1]);
    }
    client.write(['HTTP/1.1 101 Switching Protocols', ...fields, '\r\n'].join('\r\n'));
    client.write(head);
    const tearDown = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once('close', tearDown);
    upstream.once('close', tearDown);
    upstream.once('error', tearDown);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  proxy.end();
}
