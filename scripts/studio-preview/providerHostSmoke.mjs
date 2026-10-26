import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { _electron as electron, expect } from '@playwright/test';
import { startStaticServer } from '../../packages/web-host/src/static-server.ts';

const sandbox = process.env.PROVIDER_SANDBOX;
const output = process.env.PROVIDER_OUTPUT;
assert.ok(sandbox && output && process.env.PROVIDER_ENDPOINT);
const executablePath = process.env.PROVIDER_APP_EXECUTABLE;
const appEnv = { ...process.env };
if (executablePath) {
  delete appEnv.AELIX_STUDIO_RUNTIME;
  delete appEnv.AIONUI_BACKEND_BIN;
  delete appEnv.AIONUI_BUNDLED_MANAGED_RESOURCES;
  appEnv.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot ?? process.env.SYSTEMROOT}\\System32;${process.env.SystemRoot ?? process.env.SYSTEMROOT}`
      : '/usr/bin:/bin';
}
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
  cwd: executablePath ? sandbox : process.cwd(),
  env: appEnv,
  timeout: 60000,
});
// Keep only known startup markers; raw process output may contain credentials.
const startupMarkers = new Set();
const markerPatterns = [
  ['spawn_requested', '[aioncore] starting:'],
  ['default_policy', 'Default host source policy differs'],
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
for (const stream of [app.process().stdout, app.process().stderr]) {
  stream?.on('data', (chunk) => {
    const text = chunk.toString();
    for (const [code, marker] of markerPatterns) if (text.includes(marker)) startupMarkers.add(code);
  });
}
let page;
let foreign;
let webui;
try {
  page = await app.firstWindow();
  if (executablePath) {
    const require = createRequire(import.meta.url);
    const builder = createRequire(require.resolve('electron-builder'));
    const library = createRequire(builder.resolve('app-builder-lib'));
    const asar = library('@electron/asar');
    const archive = await app.evaluate(({ app }) => app.getAppPath());
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
  const native = page.getByTestId('native-provider-settings');
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
  await native.getByRole('button', { name: strings.startConversation, exact: true }).click();
  const input = page.getByTestId('sendbox-input');
  await expect(input).toBeVisible({ timeout: 30000 });
  const conversationId = await page.evaluate(() => window.location.hash.split('/conversation/')[1]?.split(/[/?]/)[0]);
  assert.ok(conversationId);
  const managedPort = await page.evaluate(() => window.__backendPort);
  const managedReady = await fetch(
    `http://127.0.0.1:${managedPort}/api/conversations/${conversationId}/runtime/ensure`,
    {
      method: 'POST',
    }
  );
  assert.equal(managedReady.status, 200);
  assert.equal((await managedReady.json()).data.operation_capability.schema, 'aelix.operation/1');
  let firstManagedOperation;
  page.on('request', (request) => {
    if (
      !firstManagedOperation &&
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/conversations/${conversationId}/messages`
    )
      firstManagedOperation = request.postDataJSON()?.operation;
  });
  await input.fill('Check rejected credentials');
  await page.getByTestId('sendbox-send-btn').click();
  // Confirm failure via host runtime rather than interpreting storage as authorization.
  await expect(page.getByText(/Invalid API key|authentication_error|401/).last()).toBeVisible({ timeout: 30000 });
  assert.equal(firstManagedOperation?.schema, 'aelix.operation/1');

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
  await input.fill('Verify first response with native credentials');
  await page.getByTestId('sendbox-send-btn').click();
  await expect(page.getByTestId('message-text-left').filter({ hasText: 'NATIVE_PROVIDER_FIRST_RESPONSE' })).toBeVisible(
    { timeout: 30000 }
  );
  assert.ok(fs.existsSync(path.join(sandbox, 'agent/auth.json')));
  assert.equal(fs.existsSync(path.join(sandbox, 'wrong-root/auth.json')), false);
  const port = await page.evaluate(() => window.__backendPort);
  const providers = await (await fetch(`http://127.0.0.1:${port}/api/providers`)).json();
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

  // Require a real WebUI cookie even though ordinary backend routes use a local default identity.
  const reset = await fetch(`http://127.0.0.1:${port}/api/webui/reset-password`, { method: 'POST' });
  assert.equal(reset.ok, true);
  const resetBody = await reset.json();
  const password = resetBody.data?.new_password ?? resetBody.new_password;
  assert.equal(typeof password, 'string');
  webui = await startStaticServer({ staticDir: path.resolve('out/renderer'), backendPort: port, port: 0 });
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
  const status = await fetch(route, { method: 'POST', headers: { ...headers, cookie }, body: '{"action":"catalog"}' });
  assert.equal(status.status, 200);
  const nativeStatus = await status.json();
  assert.equal(nativeStatus.ok, true);
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
          ? 'installed app / bundled AionCore / relocatable ACP and public native wheels'
          : 'actual built Electron / AionCore / installed ACP / public native wheel',
        webuiScope: executablePath
          ? 'source-imported facade/helper with installed backend; compiled app-owned WebUI listener not exercised'
          : 'source-imported facade/helper with development backend',
        checks: [
          'fresh_store',
          'ui_endpoint_registration',
          'ui_key_registration',
          'wrong_key_rejected',
          'installed_default_aelix_launcher_negotiates_managed_capability',
          'installed_default_aelix_sendbox_preserves_keyed_operation',
          'key_update_new_conversation',
          'first_response',
          'explicit_cli_root',
          'aion_provider_db_separate',
          'secret_endpoint_rejected',
          'unreachable_endpoint_reported',
          'untrusted_navigation_cannot_manage_credentials',
          'actual_webui_cookie_origin_and_secret_boundary',
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
  if (webui) await webui.stop();
  if (foreign) {
    foreign.closeAllConnections();
    await new Promise((resolve) => foreign.close(resolve));
  }
  await app.close();
}
