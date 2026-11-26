/** Audit production defaults without the E2E/CI/update-disable environment guards. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

export function isolatedAppEnvironment(root, source = process.env) {
  const environment = {};
  for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'TMP', 'TEMP']) {
    if (source[key]) environment[key] = source[key];
  }
  return {
    ...environment,
    PATH: process.platform === 'win32' ? `${source.SystemRoot}\\System32;${source.SystemRoot}` : '/usr/bin:/bin',
    CFFIXED_USER_HOME: path.join(root, 'home'),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    AELIX_CODING_AGENT_DIR: path.join(root, 'agent'),
    AELIX_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'),
    AELIX_AUTH_PATH: path.join(root, 'agent', 'auth.json'),
  };
}

/** Use the app's normal document guest and verify loopback loading and blocked external assets. */
export async function qualifyOfflinePreview(page, root) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'http://192.0.2.5/image.svg' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const documentPath = path.join(root, 'offline-preview.html');
    const localImage = 'http://127.0.0.1:' + port;
    fs.writeFileSync(
      documentPath,
      `<!doctype html><link rel="preconnect" href="http://192.0.2.5">
      <link rel="stylesheet" href="http://192.0.2.5/report.css">
      <img id="local" src="${localImage}/local.svg">
      <img id="redirect" src="${localImage}/redirect">
      <img id="external" src="http://192.0.2.5/image.svg">
      <script src="http://192.0.2.5/report.js"></script>`
    );
    const widths = await page.evaluate(
      (src) =>
        new Promise((resolve, reject) => {
          const guest = document.createElement('webview');
          guest.src = src;
          guest.style.cssText = 'position:fixed;width:16px;height:16px';
          const timer = setTimeout(() => {
            guest.remove();
            reject(new Error('Document guest did not finish'));
          }, 15000);
          guest.addEventListener(
            'did-finish-load',
            async () => {
              try {
                resolve(
                  await guest.executeJavaScript(
                    "['local', 'redirect', 'external'].map((id) => document.getElementById(id).naturalWidth)"
                  )
                );
              } catch (error) {
                reject(error);
              } finally {
                clearTimeout(timer);
                guest.remove();
              }
            },
            { once: true }
          );
          document.body.append(guest);
        }),
      pathToFileURL(documentPath).href
    );
    assert.deepEqual(widths, [1, 0, 0], 'Local image loads and external and redirected images are blocked');
    assert.deepEqual([...requests].sort(), ['/local.svg', '/redirect']);
    return { localImage: true, externalImage: false, externalRedirect: false };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Invoke the same desktop RPC used by the extension settings component. */
async function prepareExtensionGuest(page, partition) {
  const prepared = await page.evaluate(
    (partition) =>
      new Promise((resolve, reject) => {
        const name = 'system-settings:prepare-extension-settings-session';
        const id = crypto.randomUUID();
        const response = 'subscribe.callback-' + name + id;
        const timer = setTimeout(() => {
          off();
          reject(new Error('Extension session preparation timed out'));
        }, 10000);
        const off = window.electronAPI.on(({ value }) => {
          const message = JSON.parse(value);
          if (message.name !== response) return;
          clearTimeout(timer);
          off();
          resolve(message.data);
        });
        void window.electronAPI.emit('subscribe-' + name, { id, data: { partition } });
      }),
    partition
  );
  assert.equal(prepared, true);
}

async function openAuditGuest(page, src, partition) {
  if (partition) await prepareExtensionGuest(page, partition);
  return page.evaluate(
    ({ src, partition }) =>
      new Promise((resolve, reject) => {
        const guest = document.createElement('webview');
        if (partition) guest.setAttribute('partition', partition);
        guest.src = src;
        guest.style.cssText = 'position:fixed;width:16px;height:16px';
        const timer = setTimeout(() => {
          guest.remove();
          reject(new Error('Audit guest did not reach its local page'));
        }, 15000);
        guest.addEventListener(
          'did-finish-load',
          () => {
            clearTimeout(timer);
            guest.id = 'studio-g12-audit-guest';
            resolve(guest.getWebContentsId());
          },
          { once: true }
        );
        document.body.append(guest);
      }),
    { src, partition }
  );
}

async function guestScript(page, script) {
  return page.evaluate((code) => document.getElementById('studio-g12-audit-guest').executeJavaScript(code), script);
}

const EXTERNAL = 'http://192.0.2.5';
const OFFLINE_PROBE = `
  <!doctype html>
  <script>
    window.results = {};
    window.addEventListener('message', ({ data, source }) => {
      if (source === document.getElementById('srcdoc-fixture')?.contentWindow && data === 'studio-g12:blocked') {
        window.results.srcdoc = 'blocked';
      }
    });
  </script>
  <link rel="preconnect" href="${EXTERNAL}">
  <link rel="stylesheet" href="/local.css">
  <link rel="stylesheet" href="${EXTERNAL}/remote.css" onerror="results.css = 'blocked'">
  <img id="local" src="/local.svg">
  <img id="redirect" src="/redirect">
  <img id="external" src="${EXTERNAL}/image.svg">
  <iframe id="frame" src="/frame"></iframe>
  <iframe src="${EXTERNAL}/frame"></iframe>
  <iframe id="srcdoc-fixture" srcdoc="<img src='${EXTERNAL}/srcdoc.svg' onerror='parent.postMessage(&quot;studio-g12:blocked&quot;, &quot;*&quot;)'>"></iframe>
  <script src="/local.js"></script>
  <script src="${EXTERNAL}/report.js" onerror="results.script = 'blocked'"></script>
`;

function servePreviewFixture(request, response, close) {
  switch (request.url) {
    case '/probe':
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(OFFLINE_PROBE);
      return;
    case '/transition':
    case '/frame-transition':
      response
        .writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        .end('<!doctype html><p>loopback tab</p>');
      return;
    case '/frame':
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<body>local frame</body>');
      return;
    case '/local.js':
      response.writeHead(200, { 'Content-Type': 'application/javascript' }).end("results.localScript = 'loaded';");
      return;
    case '/local.css':
      response
        .writeHead(200, { 'Content-Type': 'text/css' })
        .end(`@import '${EXTERNAL}/stylesheet-import.css'; body { color: rgb(1, 2, 3); }`);
      return;
    case '/worker.js':
      response.writeHead(200, { 'Content-Type': 'application/javascript' }).end(`
        self.addEventListener('message', (event) => {
          event.waitUntil(fetch('${EXTERNAL}/worker', { mode: 'no-cors' }).then(
            () => event.ports[0].postMessage('sent'),
            () => event.ports[0].postMessage('blocked')
          ));
        });
      `);
      return;
    case '/hold':
      response.once('close', close);
      response.writeHead(200, { 'Content-Type': 'text/plain' }).write('held open');
      return;
    case '/redirect':
      response.writeHead(302, { Location: EXTERNAL + '/redirect.svg' }).end();
      return;
    case '/local.svg':
      response
        .writeHead(200, { 'Content-Type': 'image/svg+xml' })
        .end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
      return;
    default:
      response.writeHead(404).end();
  }
}

function verifyRendererTransport(app, id) {
  return app.evaluate(async ({ webContents }, guestId) => {
    const guest = webContents.fromId(guestId);
    return {
      proxy: await guest.session.resolveProxy('http://192.0.2.5/preconnect'),
      rtcPolicy: guest.getWebRTCIPHandlingPolicy(),
    };
  }, id);
}

async function requireOfflineTransport(app, contentsId) {
  const result = await verifyRendererTransport(app, contentsId);
  assert.match(result.proxy, /^SOCKS5 127\.0\.0\.1:\d+$/);
  assert.equal(result.rtcPolicy, 'disable_non_proxied_udp');
}

async function checkPreviewRequests(execute) {
  const results = await execute(
    `
    (async () => {
      const worker = await navigator.serviceWorker.register('/worker.js');
      const active = (await navigator.serviceWorker.ready).active;
      const message = new MessageChannel();
      const result = new Promise((resolve) => { message.port1.onmessage = ({ data }) => resolve(data); });
      active.postMessage('probe', [message.port2]);
      try {
        const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:192.0.2.5:3478' }] });
        try {
          peer.createDataChannel('fixture');
          await peer.setLocalDescription(await peer.createOffer());
          await new Promise((resolve) => setTimeout(resolve, 500));
        } finally {
          peer.close();
        }
        return {
          worker: await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve('timeout'), 8000))]),
          localImage: document.getElementById('local').naturalWidth,
          redirect: document.getElementById('redirect').naturalWidth,
          externalImage: document.getElementById('external').naturalWidth,
          localFrame: document.getElementById('frame').contentDocument.body.textContent,
          localCss: getComputedStyle(document.body).color,
          ...window.results,
        };
      } finally {
        message.port1.close();
        await worker.unregister();
      }
    })()
  `
  );
  assert.deepEqual(results, {
    worker: 'blocked',
    localImage: 1,
    redirect: 0,
    externalImage: 0,
    localFrame: 'local frame',
    localCss: 'rgb(1, 2, 3)',
    css: 'blocked',
    script: 'blocked',
    srcdoc: 'blocked',
    localScript: 'loaded',
  });
  return results;
}

async function openMainWindowFrame(page, url) {
  await page.evaluate(
    (source) =>
      new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.id = 'studio-g12-main-frame';
        frame.name = frame.id;
        frame.style.cssText = 'position:fixed;width:16px;height:16px';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin');
        frame.src = source;
        const timeout = setTimeout(() => reject(new Error('Main-window iframe timed out')), 15000);
        frame.addEventListener(
          'load',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true }
        );
        document.body.appendChild(frame);
      }),
    url
  );
  const frame = page.frame({ name: 'studio-g12-main-frame' });
  assert.equal(frame?.url(), url, 'Expected a loopback iframe in the application window');
  return frame;
}

function closeMainWindowFrame(page) {
  return page.evaluate(() => document.getElementById('studio-g12-main-frame')?.remove());
}

async function checkMainWindowFrame(page, url) {
  try {
    const frame = await openMainWindowFrame(page, url);
    return await checkPreviewRequests((code) => frame.evaluate(code));
  } finally {
    await closeMainWindowFrame(page);
  }
}

export async function qualifyOfflineTransport(app, page, toggle) {
  let closed = false;
  let frameLoads = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/frame-transition') frameLoads++;
    servePreviewFixture(req, res, () => {
      closed = true;
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const closeGuest = () => page.evaluate(() => document.getElementById('studio-g12-audit-guest')?.remove());
  try {
    const main = await app.browserWindow(page);
    const mainId = await main.evaluate((window) => window.webContents.id);
    await requireOfflineTransport(app, mainId);
    const firstMainFrame = await checkMainWindowFrame(page, base + '/probe');

    const defaultGuest = await openAuditGuest(page, base + '/probe');
    await requireOfflineTransport(app, defaultGuest);
    const defaultResults = await checkPreviewRequests((code) => guestScript(page, code));
    await closeGuest();

    const extPartition = 'persist:ext-settings-g12-audit';
    const firstExtensionGuest = await openAuditGuest(page, base + '/probe', extPartition);
    await requireOfflineTransport(app, firstExtensionGuest);
    const extensionResults = await checkPreviewRequests((code) => guestScript(page, code));
    await closeGuest();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await assertUpdateMenu(app, true);
    assert.equal((await verifyRendererTransport(app, mainId)).rtcPolicy, 'default');
    await openMainWindowFrame(page, base + '/frame-transition');
    assert.equal(frameLoads, 1);
    const transitioningGuest = await openAuditGuest(page, base + '/transition', extPartition);
    assert.equal((await verifyRendererTransport(app, transitioningGuest)).rtcPolicy, 'default');
    assert.equal(
      await guestScript(page, "fetch('/hold').then((res) => { window.heldResponse = res; return res.status; })"),
      200
    );
    assert.equal(closed, false, 'The online connection must remain open until the switch');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await assertUpdateMenu(app, false);
    await expect.poll(() => closed, { timeout: 10000 }).toBe(true);
    await requireOfflineTransport(app, transitioningGuest);
    await requireOfflineTransport(app, mainId);
    await expect.poll(() => frameLoads, { timeout: 10000 }).toBe(2);
    await closeMainWindowFrame(page);
    const mainFrameAfterSwitch = await checkMainWindowFrame(page, base + '/probe');
    await closeGuest();
    const afterSwitch = await openAuditGuest(page, base + '/probe', extPartition);
    await requireOfflineTransport(app, afterSwitch);
    await checkPreviewRequests((code) => guestScript(page, code));
    return {
      firstMainFrame,
      mainFrameAfterSwitch,
      mainFrameReloadedOnSwitch: true,
      default: defaultResults,
      firstExtension: extensionResults,
      extensionAfterSwitch: true,
      connectionClosed: true,
    };
  } finally {
    await closeMainWindowFrame(page);
    await closeGuest();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function assertUpdateMenu(app, enabled) {
  assert.equal(
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('studio-check-for-updates').enabled),
    enabled
  );
}

export async function qualifyOfflineExtensions(page, root) {
  const { writeWheel } = await import('../../packages/web-host/tests/fixtures/extensionWheels.ts');
  const name = 'studio-g12-offline';
  const wheel = await writeWheel(path.join(root, 'wheels'), { name });
  const request = (command) => page.evaluate((input) => window.__studioExtensions.request(input), command);
  for (const source of [
    { kind: 'index', name },
    { kind: 'git', url: 'git+https://192.0.2.5/studio-g12.git' },
  ]) {
    const result = await request({ action: 'install', source });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ONLINE_INSTALL_DISABLED');
  }
  const settings = await request({ action: 'get_settings' });
  assert.equal(settings.data?.onlineInstallLocked, true);
  const installed = await request({ action: 'install', source: { kind: 'file', path: wheel } });
  assert.equal(installed.ok, true, JSON.stringify(installed));
  await expect
    .poll(
      async () => {
        const status = await request({ action: 'poll', operationId: installed.data.operationId });
        assert.equal(status.ok, true, JSON.stringify(status));
        assert.ok(!['failed', 'cancelled'].includes(status.data.phase), JSON.stringify(status.data));
        return status.data.phase;
      },
      { timeout: 150000 }
    )
    .toBe('switched');
  const listed = await request({ action: 'list' });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.ok(listed.data.extensions.some((extension) => extension.name === name));
  return { fileInstalledAndListed: true, indexRefused: true, gitRefused: true };
}

export async function qualifyOfflineMcp(page) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const mcp = new McpServer({ name: 'studio-g12-mcp', version: '1.0.0' });
    mcp.registerTool('g12_fixture', { description: 'Offline-mode loopback fixture' }, () => ({ content: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => {
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const observed = await page.evaluate(
      async (endpoint) => {
        const result = await fetch('http://127.0.0.1:' + window.__backendPort + '/api/mcp/test-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'studio-g12-mcp',
            enabled: true,
            transport: { type: 'http', url: endpoint },
            created_at: 0,
            updated_at: 0,
            original_json: '{}',
          }),
        });
        const envelope = await result.json();
        return envelope.data ?? envelope;
      },
      'http://127.0.0.1:' + server.address().port + '/mcp'
    );
    assert.equal(observed.success, true, JSON.stringify(observed));
    assert.ok(observed.tools?.some((tool) => tool.name === 'g12_fixture'));
    return { connected: true, toolsListed: true };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const executablePath = process.env.PROVIDER_APP_EXECUTABLE;
  const output = process.argv[2];
  const offlineMode = process.argv.includes('--offline-mode');
  assert.ok(executablePath && output, 'Installed app path and report path are required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-default-outbound-'));
  const environment = isolatedAppEnvironment(root);
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'AELIX_CODING_AGENT_DIR',
    'AELIX_CODING_AGENT_SESSION_DIR',
  ]) {
    fs.mkdirSync(environment[key], { recursive: true });
  }
  const profile = path.join(environment.XDG_CONFIG_HOME, 'Aelix Studio');
  const upstreamProfile = path.join(environment.XDG_CONFIG_HOME, 'AionUi');
  fs.mkdirSync(upstreamProfile);
  fs.writeFileSync(path.join(upstreamProfile, 'sentinel'), 'upstream');
  const config = path.join(profile, 'config/aionui-config.txt');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(
    config,
    Buffer.from(
      encodeURIComponent(
        JSON.stringify(offlineMode ? { 'network.offlineMode': true, language: 'en-US' } : { 'update.autoCheck': false })
      )
    ).toString('base64')
  );
  const report = {
    schema: 'aelix-studio.default-startup/1',
    status: 'failed',
    e2eGuard: false,
    ciGuard: false,
    realCredentials: false,
    observationMs: 35000,
    offlineMode,
  };
  let app;
  try {
    app = await electron.launch({ executablePath, args: [], cwd: root, env: environment, timeout: 60000 });
    const paths = await app.evaluate(({ app }) => ({
      name: app.getName(),
      userData: app.getPath('userData'),
      logs: app.getPath('logs'),
    }));
    assert.deepEqual(paths, { name: 'Aelix Studio', userData: profile, logs: path.join(profile, 'logs') });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
    await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveTitle('Aelix Studio');
    assert.deepEqual(fs.readdirSync(upstreamProfile), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(upstreamProfile, 'sentinel'), 'utf8'), 'upstream');
    assert.ok(fs.readdirSync(paths.logs, { recursive: true }).some((entry) => String(entry).endsWith('.log')));
    report.studioProfile = true;
    // Stay offline through the scheduled startup check before exercising a live toggle.
    await page.waitForTimeout(report.observationMs);
    if (offlineMode) {
      await page.evaluate(() => {
        window.location.hash = '/settings/about';
      });
      const toggle = page.getByRole('switch', { name: 'Offline mode' });
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
      await expect(page.getByText('Update checks are disabled in offline mode.')).toBeVisible();
      await assertUpdateMenu(app, false);
      report.preview = await qualifyOfflinePreview(page, root);
      report.transport = await qualifyOfflineTransport(app, page, toggle);
      report.extensions = await qualifyOfflineExtensions(page, root);
      report.mcp = await qualifyOfflineMcp(page);
    }
    report.status = 'passed';
  } catch (error) {
    report.errorKind = error?.name ?? 'Error';
    throw error;
  } finally {
    await app?.close();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
