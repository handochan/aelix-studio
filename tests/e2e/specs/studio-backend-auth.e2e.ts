import { _electron, expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type FixtureMain = typeof globalThis & {
  studioFixture: { origin(): string; restart(): Promise<{ origin: string; rotated: boolean }> };
};

const fixtureRequire = createRequire(resolve('package.json'));

// This backend fixture checks the actual launcher pipe and what Chromium
// sends on the wire. Electron frame and redirect metadata come from Electron.
function backendFixture(): string {
  return `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const http = require('node:http');
const { WebSocketServer } = require(${JSON.stringify(fixtureRequire.resolve('ws'))});
const secret = readFileSync(0, 'utf8');
if (!process.argv.includes('--studio-auth') || !/^[0-9a-f]{64}$/.test(secret)) process.exit(1);
const crossOrigin = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const admitted = (req) => req.headers['x-aionui-studio-auth'] === secret &&
  (!req.headers.origin || req.headers.origin === 'http://127.0.0.1:' + server.address().port);
let preflight = false;
const server = http.createServer((req, res) => {
  const allowed = admitted(req);
  if (req.method === 'OPTIONS') preflight = allowed;
  res.writeHead(req.url === '/health' || allowed ? 200 : 403, crossOrigin);
  res.end(req.method === 'POST' ? JSON.stringify({ preflight }) : 'ok');
});
const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!admitted(req)) {
    socket.end('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n');
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => { ws.send(req.url); ws.close(); });
});
server.listen(0, '127.0.0.1', () => {
  console.log('AIONCORE_LISTENING ' + JSON.stringify({host: '127.0.0.1', port: server.address().port}));
  console.log('AIONCORE_READY');
});
`;
}

test('Electron grants the host credential only to its registered top-level document', async () => {
  test.skip(process.platform === 'win32', 'This fixture launches a POSIX executable script.');
  const directory = await mkdtemp(join(tmpdir(), 'studio-backend-auth-'));
  try {
    const binary = join(directory, 'host-fixture');
    const entry = join(directory, 'electron.cjs');
    await writeFile(binary, backendFixture(), { mode: 0o700 });
    await build({
      entryPoints: [resolve('tests/e2e/helpers/studioBackendHarness.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      external: ['electron'],
    });

    const electron = await _electron.launch({ args: [entry, binary, directory] });
    try {
      const page = await electron.firstWindow();
      await page.waitForFunction(() => document.body?.textContent === 'Fixture');
      const backend = await electron.evaluate(() => (globalThis as FixtureMain).studioFixture.origin());
      const positive = await page.evaluate(async (origin) => {
        const response = await fetch(origin + '/checked', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const result = (await response.json()) as { preflight: boolean };
        const sockets = await Promise.all(
          ['/ws', '/api/stt/stream'].map(
            (path) =>
              new Promise<string>((resolve, reject) => {
                const ws = new WebSocket(origin.replace('http:', 'ws:') + path);
                ws.onmessage = (event) => resolve(String(event.data));
                ws.onerror = () => reject(new Error('WebSocket failed'));
              })
          )
        );
        return { status: response.status, preflight: result.preflight, sockets };
      }, backend);
      expect(positive).toEqual({ status: 200, preflight: true, sockets: ['/ws', '/api/stt/stream'] });

      await page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.src = '/frame';
        document.body.appendChild(frame);
      });
      await expect(page.frameLocator('iframe').locator('body')).toHaveText('403');
      await page.evaluate(() => {
        const guest = document.createElement('webview');
        guest.src = new URL('/guest', location.href).href;
        document.body.appendChild(guest);
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const guest = document.querySelector<Electron.WebviewTag>('webview');
            return guest?.executeJavaScript('document.body.textContent').catch(() => '');
          })
        )
        .toBe('403');
      const redirectStatus = await page.evaluate(async () => (await fetch('/redirect')).status);
      expect(redirectStatus).toBe(403);

      const restart = await electron.evaluate(() => (globalThis as FixtureMain).studioFixture.restart());
      expect(restart.rotated).toBe(true);
      expect(await page.evaluate(async (url) => (await fetch(url + '/checked')).status, restart.origin)).toBe(200);
    } finally {
      await electron.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
