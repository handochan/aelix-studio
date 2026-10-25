/** Real credential acceptance. Values stay in memory/private native storage; diagnostics are structural only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const option = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const provider = option('--provider') ?? 'openrouter';
const name = option('--label') ?? provider;
assert.ok(/^[a-z0-9-]+$/.test(name));
const output = path.resolve('.local/provider-real');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
let app;
let page;
let sandbox;
let phase = 'preflight';
let sensitive = [];
let startupErrors = '';
const report = {
  provider,
  status: 'running',
  realProvider: true,
  realOAuth: provider === 'openai-codex',
  separateAuthStore: false,
  refreshExercised: false,
};
const save = () =>
  fs.writeFileSync(path.join(output, name + '.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
save();
try {
  const originalRoot = path.join(os.homedir(), '.aelix/agent');
  const credentialRoot = option('--auth-root') ? path.resolve(option('--auth-root')) : originalRoot;
  const original = fs.readFileSync(path.join(originalRoot, 'auth.json'));
  const credentials = JSON.parse(fs.readFileSync(path.join(credentialRoot, 'auth.json')))[provider];
  assert.ok(credentials);
  sensitive = [credentials.key, credentials.access, credentials.refresh].filter(Boolean);
  if (provider === 'openai-codex')
    assert.ok(
      credentials.expires > Date.now() + 600000,
      'A fresh access token is required; do not rotate the original refresh token'
    );
  const settings = JSON.parse(fs.readFileSync(path.join(originalRoot, 'settings.json')));
  const models = JSON.parse(fs.readFileSync(path.join(originalRoot, 'models.json')));
  const model = option('--model') ?? (provider === 'openrouter' ? settings.defaultModel : 'gpt-6-luna');
  report.model = model;
  report.separateAuthStore = credentialRoot !== originalRoot;
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'Studio Provider 한글 '));
  const agent = path.join(sandbox, 'agent');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(
    path.join(agent, 'models.json'),
    JSON.stringify({ providers: { [provider]: models.providers[provider] } }),
    { mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(agent, 'settings.json'),
    JSON.stringify({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: 'off',
      checkForUpdates: false,
    }),
    { mode: 0o600 }
  );
  if (provider === 'openai-codex')
    fs.writeFileSync(path.join(agent, 'auth.json'), JSON.stringify({ [provider]: credentials }), { mode: 0o600 });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|AELIX_|OPENAI_|ANTHROPIC_|SENTRY_|ELECTRON_RENDERER_URL|AIONUI_BACKEND_BIN/.test(
          key
        )
    )
  );
  Object.assign(env, {
    HOME: home,
    AELIX_CODING_AGENT_DIR: agent,
    AIONUI_E2E_TEST: '1',
    AIONUI_E2E_USER_DATA_DIR: path.join(sandbox, 'studio'),
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_CDP_PORT: '0',
    AIONUI_EXTENSIONS_PATH: path.join(sandbox, 'extensions'),
    AIONUI_EXTENSION_STATES_FILE: path.join(sandbox, 'extension-states.json'),
  });
  fs.mkdirSync(env.AIONUI_EXTENSIONS_PATH);
  const executablePath = option('--executable');
  const runtime = option('--runtime');
  if (runtime) env.AELIX_STUDIO_RUNTIME = path.resolve(runtime);
  if (option('--backend')) env.AIONUI_BACKEND_BIN = path.resolve(option('--backend'));
  const launch = async () =>
    electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? [] : ['.'],
      cwd: executablePath ? sandbox : process.cwd(),
      env,
      timeout: 60000,
    });
  phase = 'app_launch';
  app = await launch();
  app.process().stderr?.on('data', (chunk) => {
    if (phase === 'app_ready' && startupErrors.length < 30000) startupErrors += chunk.toString();
  });
  phase = 'app_ready';
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0 && window.__studioNativeAuth, undefined, {
    timeout: 60000,
  });
  await page.waitForFunction(() => (document.querySelector('#root')?.textContent?.length ?? 0) > 100, undefined, {
    timeout: 60000,
  });
  phase = 'native_settings';
  await page.evaluate(() => {
    window.location.hash = '/settings/model';
  });
  const native = page.getByTestId('native-provider-settings');
  await expect(native).toContainText('auth.json', { timeout: 20000 });
  const language = await page.evaluate(() => document.documentElement.lang);
  const strings = JSON.parse(
    fs.readFileSync(path.resolve('packages/desktop/src/renderer/services/i18n/locales', language, 'settings.json'))
  ).nativeAuth;
  const catalog = await page.evaluate(() => window.__studioNativeAuth.request({ action: 'catalog' }));
  phase = 'catalog_' + (catalog.ok ? 'available' : catalog.code);
  assert.equal(catalog.ok, true);
  const providerInfo = catalog.data.providers.find((entry) => entry.id === provider);
  const modelInfo = providerInfo.models.find((entry) => entry.id === model);
  assert.ok(modelInfo);
  const select = async (index, label, value) => {
    const stage = index === 0 ? 'select_provider' : 'select_model';
    phase = stage + '_open';
    const control = native.locator('.arco-select').nth(index);
    await control.click();
    phase = stage + '_search';
    await control.locator('input').fill(value);
    phase = stage + '_option';
    await page.locator('.arco-select-popup:visible').getByText(label, { exact: true }).last().click();
  };
  await select(0, providerInfo.name, provider);
  await select(1, modelInfo.name, model);
  if (provider === 'openrouter') {
    phase = 'api_key_registration';
    await native.getByText(strings.exclusive, { exact: true }).click();
    const input = native.getByLabel(strings.key, { exact: true });
    await input.fill(credentials.key);
    await native.getByRole('button', { name: strings.saveKey, exact: true }).click();
    await expect.poll(async () => (await input.inputValue()) === '').toBe(true);
  }
  const selection = await page.evaluate(
    ({ provider, model }) => window.__studioNativeAuth.request({ action: 'select', provider, model }),
    { provider, model }
  );
  assert.equal(selection.ok, true);
  if (executablePath && !runtime)
    assert.ok(selection.data.args.some((entry) => entry.includes('.app/Contents/Resources/studio-preview/')));
  await native.getByRole('button', { name: strings.startConversation, exact: true }).click();
  const conversationId = await page
    .waitForFunction(() => location.hash.match(/conversation\/([^/?]+)/)?.[1], undefined, { timeout: 30000 })
    .then((handle) => handle.jsonValue());
  phase = 'first_response';
  const marker = 'STUDIO_PROVIDER_ACCEPTED';
  const send = async () => {
    const responses = page.getByTestId('message-text-left').filter({ hasText: marker });
    const before = await responses.count();
    const input = page.getByTestId('sendbox-input');
    await expect(input).toBeVisible({ timeout: 30000 });
    await input.fill('Reply exactly STUDIO_PROVIDER_ACCEPTED. Do not use any tools.');
    await page.getByTestId('sendbox-send-btn').click();
    await expect(responses).toHaveCount(before + 1, { timeout: 120000 });
    await expect(page.locator('.sendbox-stop-button')).toBeHidden({ timeout: 120000 });
  };
  await send();
  await page.screenshot({ path: path.join(output, name + '-response.png') });
  await app.close();
  app = undefined;
  phase = 'restart';
  app = await launch();
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  await page.evaluate((id) => {
    window.location.hash = '/conversation/' + id;
  }, conversationId);
  await send();
  await app.close();
  app = undefined;
  phase = 'secret_and_original_audit';
  assert.ok(fs.readFileSync(path.join(originalRoot, 'auth.json')).equals(original));
  const after = JSON.parse(fs.readFileSync(path.join(agent, 'auth.json')))[provider];
  if (provider === 'openai-codex') {
    assert.equal(after.access, credentials.access);
    assert.equal(after.refresh, credentials.refresh);
  }
  const secrets = [credentials.key, credentials.access, credentials.refresh]
    .filter(Boolean)
    .map((entry) => Buffer.from(entry));
  let scanned = 0;
  for (const file of fs.readdirSync(sandbox, { recursive: true, withFileTypes: true })) {
    const absolute = path.join(file.parentPath, file.name);
    if (file.isFile() && /\.(log|jsonl|db|sqlite|sqlite3)(-wal)?$/.test(file.name)) {
      const bytes = fs.readFileSync(absolute);
      assert.ok(!secrets.some((secret) => bytes.includes(secret)));
      scanned++;
    }
  }
  Object.assign(report, {
    status: 'passed',
    firstResponse: true,
    restartResumeResponse: true,
    originalAuthUnchanged: true,
    secretScanFiles: scanned,
    secretMatches: 0,
    installedApp: !!executablePath,
  });
  fs.rmSync(path.join(output, name + '-failure.txt'), { force: true });
  save();
  console.log(JSON.stringify({ provider, status: 'passed', restartResumeResponse: true }));
} catch (error) {
  let diagnostic =
    String(error?.message ?? '') +
    '\n' +
    startupErrors
      .split('\n')
      .filter((line) => /error|denied|failed|permitted/i.test(line))
      .join('\n');
  for (const value of sensitive) diagnostic = diagnostic.replaceAll(value, '[REDACTED]');
  diagnostic = diagnostic.replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_.-]+/g, '[REDACTED]');
  fs.writeFileSync(path.join(output, name + '-failure.txt'), diagnostic.slice(0, 5000), { mode: 0o600 });
  if (page && (phase.startsWith('select_') || phase === 'native_settings'))
    await page.screenshot({ path: path.join(output, name + '-selection.png') }).catch(() => {});
  Object.assign(report, { status: 'failed', phase, failureKind: error?.name ?? 'Error' });
  save();
  console.log(JSON.stringify({ provider, status: 'failed', phase }));
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
}
