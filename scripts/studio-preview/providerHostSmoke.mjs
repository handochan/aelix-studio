import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron as electron, expect } from '@playwright/test';
import { resolveStandaloneStudioUserDataPath, startWebHost } from '../../packages/web-host/src/index.ts';
import httpBridge from '../../tests/e2e/helpers/httpBridge.ts';
import { boundedWait, closeElectron } from './host-release/verification.mjs';

const { httpGet, httpPost } = httpBridge;

const sandbox = process.env.PROVIDER_SANDBOX;
const output = process.env.PROVIDER_OUTPUT;
const driverPython = process.env.PROVIDER_DRIVER_PYTHON;
assert.ok(sandbox && output && process.env.PROVIDER_ENDPOINT && driverPython);
const executablePath = process.env.PROVIDER_APP_EXECUTABLE;
const appEnv = { ...process.env };
delete appEnv.PROVIDER_DRIVER_PYTHON;
if (executablePath) {
  delete appEnv.AELIX_STUDIO_RUNTIME;
  delete appEnv.AIONUI_BACKEND_BIN;
  delete appEnv.AIONUI_BUNDLED_MANAGED_RESOURCES;
  appEnv.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot ?? process.env.SYSTEMROOT}\\System32;${process.env.SystemRoot ?? process.env.SYSTEMROOT}`
      : '/usr/bin:/bin';
}
// Keep only known startup markers; raw process output may contain credentials.
const startupMarkers = new Set();
const markerPatterns = [
  ['spawn_requested', '[aioncore] starting:'],
  ['default_policy', 'Default host release policy differs'],
  ['default_receipt', 'Default host build receipt changed'],
  ['default_provenance', 'Default host build provenance differs'],
  ['default_code', 'Default host code or upstream license changed'],
  ['default_inventory', 'Default host resource inventory changed'],
  ['default_resources', 'Default host managed resources differ'],
  ['default_resource_contract', 'Default host managed resource contract differs'],
  ['resolve_binary', "stage: 'resolve_binary'"],
  ['spawn_error', "stage: 'spawn_error'"],
  ['early_exit', "stage: 'early_exit'"],
  ['missing_file', 'ENOENT'],
  ['access_denied', 'EACCES'],
];
async function launch() {
  const launched = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: executablePath ? sandbox : process.cwd(),
    env: appEnv,
    timeout: 60000,
  });
  for (const stream of [launched.process().stdout, launched.process().stderr]) {
    stream?.on('data', (chunk) => {
      const text = chunk.toString();
      for (const [code, marker] of markerPatterns) if (text.includes(marker)) startupMarkers.add(code);
    });
  }
  return launched;
}
function readForkIdentity(parentId, childId) {
  const script = path.join(import.meta.dirname, 'providerSmoke.py');
  const result = spawnSync(driverPython, ['-I', '-B', script, '--read-fork-identity', sandbox, parentId, childId], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, `Could not read the native fork identity: ${result.error ?? result.stderr}`);
  return JSON.parse(result.stdout);
}
async function waitForIdle(page, route) {
  await expect
    .poll(
      async () => {
        const { runtime } = await httpGet(page, route);
        return runtime?.state === 'idle' && !runtime.is_processing && runtime.turn_id == null;
      },
      { timeout: 30000 }
    )
    .toBe(true);
}
let app;
let page;
let lanPage;
let foreign;
let webui;
let sharedDbLink;
let stage = 'startup';
const lanFailures = [];
const trace = (next) => {
  stage = next;
  fs.writeFileSync(path.join(output, 'ui-stage.json'), JSON.stringify({ stage }) + '\n');
};
try {
  app = await launch();
  let archive;
  if (executablePath) {
    const selected = process.env.AELIX_STUDIO_RUNTIME;
    assert.ok(selected, 'Installed smoke requires the selected helper runtime');
    // Read immutable install identity once, before the renderer starts navigating.
    const identity = await app.evaluate(({ app }) => ({
      resourcesPath: process.resourcesPath,
      archive: app.getAppPath(),
    }));
    archive = identity.archive;
    const installed = path.join(identity.resourcesPath, 'studio-preview');
    // Keep the source facade's launch identity identical to the actual app;
    // Windows filesystem namespace prefixes must not create a second agent recipe.
    assert.equal(fs.realpathSync.native(selected), fs.realpathSync.native(installed));
    process.env.AELIX_STUDIO_RUNTIME = installed;
  }
  page = await app.firstWindow();
  if (executablePath) {
    const require = createRequire(import.meta.url);
    const builder = createRequire(require.resolve('electron-builder'));
    const library = createRequire(builder.resolve('app-builder-lib'));
    const asar = library('@electron/asar');
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    for (const name of ['out/main/index.js', 'out/preload/index.js']) {
      assert.equal(
        hash(asar.extractFile(archive, path.normalize(name))),
        hash(fs.readFileSync(name)),
        'Installed compiled host differs from this build'
      );
    }
    const entries = asar
      .listPackage(archive)
      .map((entry) => entry.replaceAll('\\', '/').replace(/^\//, ''))
      .filter((entry) => entry.startsWith('out/renderer/') && entry.endsWith('.js'));
    for (const name of entries) {
      assert.equal(
        hash(asar.extractFile(archive, path.normalize(name))),
        hash(fs.readFileSync(name)),
        'Installed renderer differs from this build'
      );
    }
    const compiled = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.name.endsWith('.js')) compiled.push(file.replaceAll('\\', '/'));
      }
    };
    visit('out/renderer');
    assert.ok(entries.length > 0, 'Installed renderer inventory is empty');
    assert.deepEqual(entries.sort(), compiled.sort(), 'Installed renderer inventory differs from this build');
  }
  await page.waitForFunction(() => window.__backendPort > 0 && window.__studioNativeAuth, undefined, {
    timeout: 60000,
  });
  await page.waitForFunction(() => (document.querySelector('#root')?.textContent?.length ?? 0) > 100, undefined, {
    timeout: 60000,
  });
  await page.evaluate(() => {
    window.location.hash = '/settings/model';
  });
  let native = page.getByTestId('native-provider-settings');
  await expect(native).toBeVisible({ timeout: 30000 });
  await expect(native).toContainText('auth.json', { timeout: 15000 });
  const language = await page.evaluate(() => document.documentElement.lang);
  const strings = JSON.parse(
    fs.readFileSync(path.join('packages/desktop/src/renderer/services/i18n/locales', language, 'settings.json'))
  ).nativeAuth;
  await native.getByText(strings.exclusive, { exact: true }).click();
  await native.getByText(strings.customEndpoint, { exact: true }).click();
  await native.getByLabel(strings.providerId, { exact: true }).fill('fixture');
  await native.getByLabel(strings.model, { exact: true }).last().fill('fixture-model');
  await native.getByLabel(strings.endpoint, { exact: true }).fill(process.env.PROVIDER_ENDPOINT);
  await native.getByRole('button', { name: strings.saveEndpoint, exact: true }).click();
  await expect(native.getByText('fixture-model', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  const keyInput = native.getByLabel(strings.key, { exact: true });
  await keyInput.fill('synthetic-wrong-key');
  await native.getByRole('button', { name: strings.saveKey, exact: true }).click();
  await expect(keyInput).toHaveValue('');
  await expect(native.getByRole('button', { name: strings.startConversation, exact: true })).toBeEnabled({
    timeout: 15000,
  });
  const userDataPath = await app.evaluate(({ app }) => app.getPath('userData'));
  const expectedExtensionState = path.join(fs.realpathSync(userDataPath), 'aelix-runtime');
  const registration = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/custom'
  );
  await native.getByRole('button', { name: strings.startConversation, exact: true }).click();
  assert.equal(
    (await registration).postDataJSON().env?.find(({ name }) => name === 'AELIX_STUDIO_EXTENSION_STATE')?.value,
    expectedExtensionState,
    'The managed command must send the original Studio data path to the host as an environment value'
  );
  let input = page.getByTestId('sendbox-input');
  await expect(input).toBeVisible({ timeout: 30000 });
  await input.fill('Check rejected credentials');
  await page.getByTestId('sendbox-send-btn').click();
  // Confirm failure via host runtime rather than interpreting storage as authorization.
  await expect(page.getByText(/Invalid API key|authentication_error|401/).last()).toBeVisible({ timeout: 30000 });

  await page.evaluate(() => {
    window.location.hash = '/settings/model';
  });
  await expect(native).toContainText('auth.json', { timeout: 15000 });
  await native.getByText(strings.exclusive, { exact: true }).click();
  await keyInput.fill('synthetic-provider-key');
  await native.getByRole('button', { name: strings.saveKey, exact: true }).click();
  await expect(keyInput).toHaveValue('');
  await expect(native.getByRole('button', { name: strings.startConversation, exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await native.getByRole('button', { name: strings.startConversation, exact: true }).click();
  await expect(input).toBeVisible({ timeout: 30000 });
  const parentMarker = 'SYNTHETIC_HEAD_FORK_PARENT';
  const childMarker = 'SYNTHETIC_HEAD_FORK_CHILD';
  const restartMarker = 'SYNTHETIC_HEAD_FORK_RESTART';
  const providerReply = 'NATIVE_PROVIDER_FIRST_RESPONSE';
  const marker = (value) => page.getByTestId('message-text-content').filter({ hasText: new RegExp(`^${value}$`) });
  await input.fill(parentMarker);
  await page.getByTestId('sendbox-send-btn').click();
  await expect(marker(providerReply)).toHaveCount(1, { timeout: 30000 });
  assert.ok(fs.existsSync(path.join(sandbox, 'agent/auth.json')));
  assert.equal(fs.existsSync(path.join(sandbox, 'wrong-root/auth.json')), false);
  let port = await page.evaluate(() => window.__backendPort);
  const providers = await httpGet(page, '/api/providers');
  assert.ok(!JSON.stringify(providers).includes('synthetic-provider-key'));
  // A credential-bearing endpoint is refused before writing native config.
  const badEndpoint = await page.evaluate(async () => {
    const status = await window.__studioNativeAuth.request({ action: 'catalog' });
    return window.__studioNativeAuth.request({
      action: 'endpoint',
      provider: 'fixture',
      model: 'fixture-model',
      endpoint: 'https://example.invalid/v1?key=synthetic-secret',
      api: 'openai-completions',
      revision: status.data.revision,
      exclusive: true,
    });
  });
  assert.deepEqual(badEndpoint, { ok: false, code: 'INVALID_ENDPOINT' });
  await page.screenshot({ path: path.join(output, 'first-response.png') });

  trace('native_head_fork');
  const parentId = await page.evaluate(() => /^#\/conversation\/([^/]+)$/.exec(window.location.hash)?.[1]);
  assert.ok(parentId, 'The Provider conversation must be open before fork');
  const parentRoute = `/api/conversations/${parentId}`;
  const anonymous = await fetch(`http://127.0.0.1:${port}${parentRoute}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).code, 'AUTH_REQUIRED');
  const capability = (await httpGet(page, parentRoute)).fork_capability;
  assert.equal(capability?.at_turn, false);
  assert.equal(capability?.requires_native_head, true, 'The pinned host must guard native HEAD');
  await waitForIdle(page, parentRoute);
  await marker(providerReply).hover();
  const fork = page.getByTestId('message-fork-button');
  await expect(fork).toHaveCount(1);
  await fork.click();
  const childRoute = await page.waitForFunction(
    (id) => {
      const match = /^#\/conversation\/([^/]+)$/.exec(window.location.hash);
      return match && match[1] !== id ? match[1] : null;
    },
    parentId,
    { timeout: 30000 }
  );
  const childId = await childRoute.jsonValue();
  await expect(marker(parentMarker)).toHaveCount(1, { timeout: 30000 });
  await input.fill(childMarker);
  await page.getByTestId('sendbox-send-btn').click();
  await expect(marker(providerReply)).toHaveCount(2, { timeout: 30000 });
  const childEndpoint = `/api/conversations/${childId}`;
  await waitForIdle(page, childEndpoint);
  const beforeRestart = readForkIdentity(parentId, childId);

  trace('native_head_fork_restart');
  const previousPid = app.process().pid;
  const previousPort = port;
  await closeElectron(app, { phase: 'fork-restart-main-exit' });
  app = undefined;
  page = undefined;
  await expect
    .poll(
      async () => {
        try {
          await fetch(`http://127.0.0.1:${previousPort}/api/assistants`, { signal: AbortSignal.timeout(2000) });
          return false;
        } catch (error) {
          return error.cause?.code === 'ECONNREFUSED';
        }
      },
      { timeout: 15000 }
    )
    .toBe(true);
  app = await launch();
  assert.notEqual(app.process().pid, previousPid);
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0 && window.__studioNativeAuth, undefined, {
    timeout: 60000,
  });
  port = await page.evaluate(() => window.__backendPort);
  await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
  await page.locator(`[id="c-${childId}"]`).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/conversation/${childId}`);
  await boundedWait(httpPost(page, `${childEndpoint}/runtime/ensure`), 'fork-runtime-resume', { timeoutMs: 30000 });
  await waitForIdle(page, childEndpoint);
  assert.deepEqual(readForkIdentity(parentId, childId), beforeRestart);
  await expect(marker(parentMarker)).toHaveCount(1, { timeout: 30000 });
  await expect(marker(childMarker)).toHaveCount(1);
  await expect(marker(providerReply)).toHaveCount(2);
  input = page.getByTestId('sendbox-input');
  native = page.getByTestId('native-provider-settings');
  await input.fill(restartMarker);
  await page.getByTestId('sendbox-send-btn').click();
  await expect(marker(providerReply)).toHaveCount(3, { timeout: 30000 });
  await expect(marker(parentMarker)).toHaveCount(1);
  await expect(marker(childMarker)).toHaveCount(1);
  await waitForIdle(page, childEndpoint);

  await page.evaluate(() => {
    window.location.hash = '/settings/model';
  });
  await expect(native).toContainText('auth.json', { timeout: 15000 });
  const badNetwork = await page.evaluate(async () => {
    const status = await window.__studioNativeAuth.request({ action: 'catalog' });
    return window.__studioNativeAuth.request({
      action: 'endpoint',
      provider: 'fixture',
      model: 'fixture-model',
      endpoint: 'http://127.0.0.1:1/v1',
      api: 'openai-completions',
      revision: status.data.revision,
      exclusive: true,
    });
  });
  assert.equal(badNetwork.ok, true);
  await native.getByRole('button', { name: strings.refresh, exact: true }).click();
  await native.getByRole('button', { name: strings.startConversation, exact: true }).click();
  await expect(input).toBeVisible({ timeout: 30000 });
  await input.fill('Verify unreachable endpoint');
  await page.getByTestId('sendbox-send-btn').click();
  await expect(
    page
      .getByText(/All connection attempts failed|Connection error|Connection refused|ECONNREFUSED|connection_error/)
      .last()
  ).toBeVisible({ timeout: 30000 });

  // Operator setup uses the authenticated Electron renderer. The WebUI
  // below must obtain its own browser session before accessing native auth.
  const reset = await httpPost(page, '/api/webui/reset-password');
  const password = reset.new_password;
  assert.equal(typeof password, 'string');
  const sharedDb = path.join(sandbox, '.aionui-dev');
  fs.symlinkSync(path.join(userDataPath, 'aionui'), sharedDb, 'junction');
  sharedDbLink = sharedDb;
  webui = await startWebHost({
    app: {
      version: '0.0.0',
      isPackaged: false,
      resourcesPath: process.cwd(),
      userDataPath: await resolveStandaloneStudioUserDataPath(sharedDb),
    },
    staticDir: path.resolve('out/renderer'),
    dataDir: sharedDb,
    backend: { kind: 'useExistingBackend', port },
    port: 0,
    allowRemote: true,
  });
  const headers = {
    origin: webui.localUrl,
    'content-type': 'application/json',
    'x-studio-auth': '1',
    connection: 'close',
  };
  const route = webui.localUrl + '/api/studio/native-auth';
  assert.equal((await fetch(route, { method: 'POST', headers, body: '{"action":"catalog"}' })).status, 401);
  const login = await fetch(webui.localUrl + '/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: 'admin', password, remember: false }),
  });
  assert.equal(login.ok, true);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(cookie.length > 0);
  const status = await fetch(route, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: '{"action":"catalog"}',
  });
  assert.equal(status.status, 200);
  const nativeStatus = await status.json();
  assert.equal(nativeStatus.ok, true);
  const selected = await fetch(route, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: JSON.stringify({ action: 'select', provider: 'fixture', model: 'fixture-model' }),
  });
  const selectedLaunch = await selected.json();
  assert.equal(
    selectedLaunch.data?.env?.find(({ name }) => name === 'AELIX_STUDIO_EXTENSION_STATE')?.value,
    expectedExtensionState,
    'The WebUI must use the same Studio data path as the desktop'
  );
  const stored = await fetch(route, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: JSON.stringify({
      action: 'setKey',
      provider: 'fixture',
      key: 'synthetic-provider-key',
      revision: nativeStatus.data.revision,
      exclusive: true,
    }),
  });
  const storedStatus = await stored.json();
  assert.equal(storedStatus.ok, true);
  assert.equal(JSON.stringify(storedStatus).includes('synthetic-provider-key'), false);
  assert.equal(
    (
      await fetch(route, {
        method: 'POST',
        headers: { ...headers, cookie, origin: 'https://foreign.invalid' },
        body: '{"action":"catalog"}',
      })
    ).status,
    403
  );

  // Open the actual HTTP WebUI on a non-loopback LAN address. A new BrowserWindow
  // has no preload or Node access: Web Locks must be absent in this insecure context.
  assert.ok(webui.networkUrl, 'LAN address is required for the HTTP regression');
  const lanUrl = webui.networkUrl;
  const lanHeaders = { ...headers, origin: lanUrl };
  trace('lan_login');
  const lanLogin = await fetch(lanUrl + '/login', {
    method: 'POST',
    headers: lanHeaders,
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ username: 'admin', password, remember: false }),
  });
  assert.equal(lanLogin.ok, true);
  await app.context().addCookies(
    lanLogin.headers.getSetCookie().map((value) => {
      const [name, ...parts] = value.split(';')[0].split('=');
      return { name, value: parts.join('='), url: lanUrl, httpOnly: true };
    })
  );
  const endpointStatus = await (
    await fetch(route, { method: 'POST', headers: { ...headers, cookie }, body: '{"action":"catalog"}' })
  ).json();
  const restoredEndpoint = await fetch(route, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: JSON.stringify({
      action: 'endpoint',
      provider: 'fixture',
      model: 'fixture-model',
      endpoint: process.env.PROVIDER_ENDPOINT,
      api: 'openai-completions',
      revision: endpointStatus.data.revision,
      exclusive: true,
    }),
  });
  assert.equal((await restoredEndpoint.json()).ok, true);
  trace('lan_window');
  const lanWindow = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const window = new BrowserWindow({
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    void window.loadURL(url + '/#/settings/model');
  }, lanUrl);
  lanPage = await lanWindow;
  const lanBrowserWindow = await app.browserWindow(lanPage);
  lanPage.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/api/') && response.status() >= 400 && lanFailures.length < 20)
      lanFailures.push({ path: pathname, status: response.status() });
  });
  lanPage.on('pageerror', (error) => {
    if (lanFailures.length < 20) lanFailures.push({ pageError: error.message.slice(0, 200) });
  });
  await lanBrowserWindow.evaluate((window) => {
    window.show();
    window.focus();
  });
  await lanPage.waitForURL(`${lanUrl}/#/settings/model`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  trace('lan_http_document_loaded');
  assert.deepEqual(await lanPage.evaluate(() => ({ secure: window.isSecureContext, locks: typeof navigator.locks })), {
    secure: false,
    locks: 'undefined',
  });
  trace('lan_settings');
  const lanNative = lanPage.getByTestId('native-provider-settings');
  await expect(lanNative).toBeVisible({ timeout: 30000 });
  const lanLanguage = await lanPage.evaluate(() => document.documentElement.lang);
  const lanStrings = JSON.parse(
    fs.readFileSync(path.join('packages/desktop/src/renderer/services/i18n/locales', lanLanguage, 'settings.json'))
  ).nativeAuth;
  trace('lan_create_conversation');
  await lanNative.getByRole('button', { name: lanStrings.startConversation, exact: true }).click();
  await expect(lanPage.getByTestId('sendbox-input')).toBeVisible({ timeout: 30000 });
  trace('lan_send');
  await lanPage.getByTestId('sendbox-input').fill('SYNTHETIC_LAN_HTTP_FIRST_RESPONSE');
  await lanPage.getByTestId('sendbox-send-btn').click();
  await expect(
    lanPage.getByTestId('message-text-left').filter({ hasText: 'NATIVE_PROVIDER_FIRST_RESPONSE' })
  ).toBeVisible({ timeout: 30000 });
  trace('lan_response');
  await lanPage.screenshot({ path: path.join(output, 'lan-http-first-response.png') });
  const lanClosed = lanPage.waitForEvent('close', { timeout: 10000 });
  await lanBrowserWindow.evaluate((window) => window.destroy());
  await lanClosed;
  await lanBrowserWindow.dispose();
  trace('lan_closed');

  trace('foreign_navigation');
  foreign = http.createServer((_req, res) => res.end('<html><body>Untrusted navigation fixture</body></html>'));
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  await page.goto(`http://127.0.0.1:${foreign.address().port}`);
  const denied = await page.evaluate(async () =>
    window.__studioNativeAuth
      ? await window.__studioNativeAuth.request({ action: 'catalog' })
      : { ok: false, code: 'NO_BRIDGE' }
  );
  assert.equal(denied.ok, false);
  assert.ok(['FORBIDDEN', 'NO_BRIDGE'].includes(denied.code));
  fs.writeFileSync(
    path.join(output, 'host.json'),
    JSON.stringify(
      {
        status: 'pending_payload_audit',
        installedCompiledBuildMatched: Boolean(executablePath),
        platform: process.platform + '-' + process.arch,
        host: executablePath
          ? 'installed app / bundled AionCore / relocatable ACP and pinned native source wheels'
          : 'actual built Electron / AionCore / installed ACP / public native wheel',
        webuiScope: executablePath
          ? 'source-imported facade/helper with installed backend; compiled app-owned WebUI listener not exercised'
          : 'source-imported facade/helper with development backend',
        headFork: { parentId, childId, beforeRestart },
        checks: [
          'fresh_store',
          'ui_endpoint_registration',
          'ui_key_registration',
          'wrong_key_rejected',
          'key_update_new_conversation',
          'desktop_managed_command_extension_state',
          'first_response',
          'native_head_fork_desktop_authentication',
          'native_head_fork_ui_and_full_app_host_restart',
          'explicit_cli_root',
          'aion_provider_db_separate',
          'secret_endpoint_rejected',
          'unreachable_endpoint_reported',
          'untrusted_navigation_cannot_manage_credentials',
          'actual_webui_cookie_origin_and_secret_boundary',
          'standalone_webui_shared_database_extension_state',
          'lan_http_insecure_context_without_web_locks_sends_and_receives',
        ],
        realProvider: false,
        realOAuth: false,
        installer: false,
      },
      null,
      2
    ) + '\n'
  );
} catch (error) {
  fs.writeFileSync(
    path.join(output, 'ui-failure.json'),
    JSON.stringify({ stage, errorName: error instanceof Error ? error.name : typeof error, lanFailures }) + '\n'
  );
  if (lanPage) await lanPage.screenshot({ path: path.join(output, 'failure-lan.png'), timeout: 5000 }).catch(() => {});
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    const state = await page
      .evaluate(() => {
        const failure = window.__backendStartupBridge?.getState() ?? window.__backendStartupFailure;
        const result = { failed: window.__backendStartupFailed === true, portReady: window.__backendPort > 0 };
        for (const key of ['reason', 'backendBoundaryCode', 'backendBoundaryStage', 'incompleteInstallationKind']) {
          if (typeof failure?.[key] === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(failure[key]))
            result[key] = failure[key];
        }
        return result;
      })
      .catch(() => ({ unavailable: true }));
    fs.writeFileSync(
      path.join(output, 'startup-failure.json'),
      JSON.stringify({ ...state, markers: [...startupMarkers] }) + '\n'
    );
  }
  throw error;
} finally {
  // Close the owned browser clients before waiting for fixture TCP listeners.
  try {
    trace('stop_app');
    await closeElectron(app);
    trace('stop_webui');
    if (webui) await webui.stop();
  } finally {
    // The outer fork audit counts database paths, including Windows junctions.
    if (sharedDbLink) fs.unlinkSync(sharedDbLink);
  }
  if (foreign) {
    foreign.closeAllConnections();
    await new Promise((resolve) => foreign.close(resolve));
  }
  trace('stopped');
}
