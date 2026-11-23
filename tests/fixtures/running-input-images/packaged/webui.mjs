import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { boundedWait } from '../../../../scripts/studio-preview/host-release/verification.mjs';

async function loopbackPort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export async function startWebUI({ executable, cwd, env, password, setupPage, stage }) {
  assert.ok(typeof password === 'string' && password.length > 0);
  const port = await loopbackPort();
  const loopback = 'http://127.0.0.1:' + port;
  const windows = process.platform === 'win32';
  const args = ['--webui', '--port=' + port];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox');
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: 'ignore',
    detached: !windows,
    windowsHide: true,
  });
  let childError = false;
  child.on('error', () => {
    childError = true;
  });
  let browser;
  const stop = async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      if (windows) {
        const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 10000,
        });
        if (killed.status !== 0) child.kill();
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
      await boundedWait(exited, 'webui-exit', { timeoutMs: 12000, log: () => {} });
    }
  };
  const close = async () => {
    try {
      await browser?.close();
    } finally {
      await stop();
    }
  };
  try {
    stage('webui-server');
    await expect
      .poll(
        async () => {
          if (childError || child.exitCode !== null || child.signalCode !== null) {
            throw new Error('Packaged WebUI launch failed');
          }
          return fetch(loopback, { signal: AbortSignal.timeout(1000) }).then(
            (reply) => reply.ok,
            () => false
          );
        },
        { timeout: 60000 }
      )
      .toBe(true);
    stage('webui-browser');
    browser = await chromium.launch({
      channel: 'chromium',
      executablePath: process.env.IMAGE_CHROMIUM,
      headless: true,
      env,
    });
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach();
    const browserPid = processInfo.find(({ type }) => type === 'browser')?.id;
    assert.ok(Number.isInteger(browserPid) && browserPid > 0);
    const page = await browser.newPage({ locale: 'en-US' });
    await setupPage(page);
    stage('webui-login');
    await page.goto(loopback, { waitUntil: 'domcontentloaded' });
    // The server can redirect a browser navigation to its canonical IPv6 loopback.
    const { hostname, origin } = new URL(page.url());
    assert.ok(hostname === '127.0.0.1' || hostname === '[::1]');
    assert.equal((await page.request.get(origin + '/api/conversations')).status(), 401);
    await page.locator('input[name="username"]').fill('admin');
    await page.locator('input[name="password"]').fill(password);
    const [loginReply] = await Promise.all([
      page.waitForResponse(
        (response) => response.url() === origin + '/login' && response.request().method() === 'POST'
      ),
      page.locator('button[type="submit"]').click(),
    ]);
    assert.equal(loginReply.ok(), true);
    await page.waitForURL((url) => url.hash === '#/guid');
    assert.equal((await page.request.get(origin + '/api/conversations')).status(), 200);
    return { page, pid: child.pid, browserPid, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function webuiRequest(page, path, method, body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const headers = {};
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        const key = 'aelix-studio-csrf-token=';
        const cookie = document.cookie.split('; ').find((entry) => entry.startsWith(key));
        if (cookie) headers['x-csrf-token'] = decodeURIComponent(cookie.slice(key.length));
      }
      const request = { method, headers };
      if (body !== undefined) request.body = JSON.stringify(body);
      const reply = await fetch(path, request);
      const payload = await reply.json();
      if (!reply.ok || !payload.success) throw new Error('WebUI fixture request failed');
      return payload.data;
    },
    { path, method, body }
  );
}

export const webuiApi = {
  httpGet: (page, path) => webuiRequest(page, path, 'GET'),
  httpPost: (page, path, body) => webuiRequest(page, path, 'POST', body),
};
