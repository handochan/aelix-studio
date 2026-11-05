import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron as electron, expect } from '@playwright/test';

const sandbox = process.env.RECOVERY_SANDBOX;
const output = process.env.RECOVERY_OUTPUT;
assert.ok(sandbox && output, 'Run through smoke.py with isolated synthetic state');
const executablePath = process.env.RECOVERY_APP_EXECUTABLE;
const appEnv = { ...process.env };
if (executablePath) {
  for (const name of ['AIONUI_BACKEND_BIN', 'AELIX_STUDIO_RUNTIME', 'AIONUI_BUNDLED_MANAGED_RESOURCES'])
    delete appEnv[name];
  appEnv.PATH =
    process.platform === 'win32'
      ? `${process.env.SystemRoot ?? process.env.SYSTEMROOT}\\System32;${process.env.SystemRoot ?? process.env.SYSTEMROOT}`
      : '/usr/bin:/bin';
}
let app, page, port, selector, conversationRoute, launchResources;
const appPids = [],
  checks = [];
async function launch(conversation, marker = 'SYNTHETIC_UI_ASK_RECOVERY') {
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: executablePath ? sandbox : process.cwd(),
    env: appEnv,
    timeout: 60000,
  });
  // Capture both assertions in the same early main-context evaluation.
  const identity = await app.evaluate(() => ({
    pid: process.pid,
    backendOverride: process.env.AIONUI_BACKEND_BIN,
    resourcesPath: process.resourcesPath,
  }));
  appPids.push(identity.pid);
  launchResources = identity.resourcesPath;
  if (executablePath) assert.equal(identity.backendOverride, undefined);
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  port = await page.evaluate(() => window.__backendPort);
  // Backend readiness precedes the authenticated startup router. Wait for its
  // Guid surface before navigating so an initial redirect cannot replace us.
  await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
  if (conversation) {
    await page.locator(`[id="c-${conversation}"]`).click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash), { timeout: 30000 })
      .toBe(`#/conversation/${conversation}`);
    await expect(page.getByTestId('message-list-content')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('message-text-content').filter({ hasText: new RegExp(`^${marker}$`) })).toBeVisible({
      timeout: 30000,
    });
  }
  selector = page.getByTestId('mode-selector');
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app?.close();
    process.exit(1);
  });
async function api(route, method = 'GET', body, status = [200, 201, 202]) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  assert.ok(
    status.includes(response.status),
    `${route}: HTTP ${response.status}: ${JSON.stringify(result).slice(0, 1000)}`
  );
  return result.data ?? result;
}
try {
  await launch();
  if (executablePath) {
    await expect
      .poll(async () => (await api('/api/mcp/servers')).some((row) => row.name === 'chrome-devtools'))
      .toBe(true);
    const chrome = (await api('/api/mcp/servers')).find((row) => row.name === 'chrome-devtools');
    const resources = launchResources;
    const managedRoot = path.join(
      resources,
      'bundled-aioncore',
      `${process.platform}-${process.arch}`,
      'managed-resources'
    );
    const contract = JSON.parse(fs.readFileSync(path.join(managedRoot, 'manifest.json'), 'utf8'));
    const expectedNode = path.join(managedRoot, contract.node.root, contract.node.executable);
    assert.equal(chrome.enabled, false);
    assert.equal(fs.realpathSync(chrome.transport.command), fs.realpathSync(expectedNode));
    const connection = await api('/api/mcp/test-connection', 'POST', {
      ...chrome,
      transport: {
        ...chrome.transport,
        env: { ...chrome.transport.env, PATH: path.join(sandbox, 'no-mcp-path-tools') },
      },
    });
    assert.equal(connection.success, true);
    assert.ok(connection.tools.some((tool) => tool.name === 'navigate_page'));
    checks.push('default_chrome_mcp_bundled_node_without_path');
  }
  await api('/api/agents/custom', 'POST', {
    name: 'Permission recovery synthetic ACP',
    command: process.env.RECOVERY_ADAPTER,
    args: process.env.RECOVERY_ADAPTER_ARGS
      ? JSON.parse(process.env.RECOVERY_ADAPTER_ARGS)
      : [
          '--aelix',
          process.env.RECOVERY_NATIVE_WRAPPER,
          '--provider',
          'fixture',
          '--model',
          'one',
          '--state-dir',
          path.join(sandbox, 'acp'),
        ],
    env: [],
    icon: '🧪',
  });
  const assistants = await api('/api/assistants');
  const assistant = assistants.find((item) => item.name === 'Permission recovery synthetic ACP');
  assert.ok(assistant);
  const imageDenial = await api(
    '/api/fs/fetch-remote-image',
    'POST',
    { url: 'https://example.invalid/blocked.png' },
    [403]
  );
  assert.equal(imageDenial.code, 'REMOTE_IMAGE_DISABLED');
  checks.push('remote_images_disabled_with_reason');
  // An unavailable local MCP command must produce a persisted warning, never a download.
  const blockedMcp = await api('/api/mcp/servers', 'POST', {
    name: 'Synthetic unavailable MCP',
    transport: { type: 'stdio', command: path.join(sandbox, 'missing-mcp-command'), args: [], env: {} },
  });
  const conv = await api('/api/conversations', 'POST', {
    name: 'Permission recovery',
    assistant: { id: assistant.id },
    extra: {
      workspace: path.join(sandbox, 'workspace'),
      custom_workspace: true,
      selected_mcp_server_ids: [blockedMcp.id],
    },
  });
  const route = `/api/conversations/${conv.id}`;
  conversationRoute = route;
  await api(`${route}/runtime/ensure`, 'POST');
  await page.evaluate((id) => {
    window.location.hash = `/conversation/${id}`;
  }, conv.id);
  await expect
    .poll(() => page.evaluate(() => window.location.hash), { timeout: 30000 })
    .toBe(`#/conversation/${conv.id}`);
  await expect(page.getByTestId('sendbox-input')).toBeVisible({ timeout: 30000 });
  await expect(selector).toHaveAttribute('data-current-mode', 'default', { timeout: 30000 });
  checks.push('renderer_starts_ask');
  const mcpWarning = page.getByText(
    /MCP server 'Synthetic unavailable MCP': The configured MCP command or runtime is unavailable/
  );
  await expect(mcpWarning).toBeVisible({ timeout: 30000 });
  checks.push('unavailable_mcp_reason_visible');
  await api(`${route}/runtime/restart`, 'POST');
  await expect(mcpWarning).toHaveCount(1);
  await expect(mcpWarning).toBeVisible();
  const mcpRows = await api(`${route}/messages?limit=100`);
  const rows = mcpRows.items;
  const notices = rows
    .filter((item) => item.type === 'tips')
    .map((item) => (typeof item.content === 'string' ? JSON.parse(item.content) : item.content))
    .filter((item) => item.code === 'MCP_SERVER_UNAVAILABLE');
  assert.ok(notices.length >= 2, 'Restart must persist a fresh MCP failure notice');
  assert.equal(new Set(notices.map((item) => item.supersedes_key)).size, 1);
  checks.push('mcp_supersedes_one_visible_warning');
  await page.screenshot({ path: path.join(output, 'blocked-mcp.png') });
  async function select(mode) {
    await selector.click();
    await page.getByTestId(`aionrs-mode-option-${mode}`).click();
    await expect(selector).toHaveAttribute('data-current-mode', mode, { timeout: 30000 });
  }
  async function idle() {
    await expect
      .poll(async () => (await api(`${route}/runtime/ensure`, 'POST')).runtime.state, { timeout: 30000 })
      .toBe('idle');
  }
  const target = path.join(sandbox, 'workspace', 'renderer-write.txt');
  async function toolPrompt(text, tool = ['write', { path: target, content: 'synthetic' }]) {
    fs.writeFileSync(path.join(sandbox, 'tool-request.json'), JSON.stringify(tool));
    return await api(`${route}/messages`, 'POST', { content: text });
  }
  async function consent() {
    await expect.poll(async () => (await api(`${route}/confirmations`)).length, { timeout: 20000 }).toBe(1);
    assert.equal(fs.existsSync(target), false);
    await expect(page.getByTestId('message-acp-permission-option-allow-once')).toBeVisible();
    await expect(page.getByTestId('message-acp-permission-option-reject-once')).toBeVisible();
  }
  if (executablePath) {
    await toolPrompt('SYNTHETIC_UI_ASK_DENY');
    await consent();
    await page.getByTestId('message-acp-permission-option-reject-once').click();
    await idle();
    assert.equal(fs.existsSync(target), false);
    checks.push('installed_ask_deny_actual_no_write');
    await toolPrompt('SYNTHETIC_UI_ASK_ALLOW');
    await consent();
    await page.getByTestId('message-acp-permission-option-allow-once').click();
    await idle();
    assert.ok(fs.existsSync(target));
    fs.unlinkSync(target);
    checks.push('installed_ask_allow_actual_write');
  }
  await select('yolo');
  await toolPrompt('SYNTHETIC_UI_YOLO');
  await idle();
  assert.ok(fs.existsSync(target));
  assert.equal((await api(`${route}/confirmations`)).length, 0);
  fs.unlinkSync(target);
  checks.push('renderer_yolo_selector_and_actual_write');
  if (executablePath) {
    const guarded = path.join(sandbox, 'workspace', '.env');
    await toolPrompt('SYNTHETIC_UI_YOLO_GUARD', ['write', { path: guarded, content: 'synthetic' }]);
    await idle();
    assert.equal(fs.existsSync(guarded), false);
    checks.push('installed_yolo_native_guard_still_denies');
    fs.writeFileSync(path.join(sandbox, 'deny-write'), '');
    await toolPrompt('SYNTHETIC_UI_EXTENSION_DENY');
    await idle();
    assert.equal(fs.existsSync(target), false);
    fs.unlinkSync(path.join(sandbox, 'deny-write'));
    checks.push('installed_yolo_other_extension_denial_preserved');
    const running = await toolPrompt('SYNTHETIC_UI_YOLO_STOP', ['probe_hold', {}]);
    await expect.poll(() => fs.existsSync(path.join(sandbox, 'tool-entered')), { timeout: 20000 }).toBe(true);
    await api(`${route}/cancel`, 'POST', { turn_id: running.turn_id });
    await idle();
    await expect.poll(() => fs.existsSync(path.join(sandbox, 'tool-cancelled')), { timeout: 10000 }).toBe(true);
    assert.equal(fs.existsSync(path.join(sandbox, 'workspace/late-write.txt')), false);
    checks.push('installed_yolo_stop_observed_native_cancellation_without_late_write');
  }
  if (executablePath) {
    const oldPort = port;
    await app.close();
    app = null;
    await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/api/assistants`, { signal: AbortSignal.timeout(2000) }));
    await launch(conv.id, 'SYNTHETIC_UI_YOLO');
    await api(`${route}/runtime/ensure`, 'POST');
    await expect(selector).toHaveAttribute('data-current-mode', 'yolo', { timeout: 30000 });
    await toolPrompt('SYNTHETIC_UI_YOLO_RESTORED');
    await idle();
    assert.ok(fs.existsSync(target));
    assert.equal((await api(`${route}/confirmations`)).length, 0);
    fs.unlinkSync(target);
    checks.push('installed_full_app_and_host_process_restart_restores_display_and_effective_yolo');
  }
  // ACP persists the Ask downgrade before calling native. Close that native RPC
  // under fail-start so the host still caches Yolo while the adapter reports Ask
  // on session/load; the released host must adopt the restored policy.
  fs.writeFileSync(path.join(sandbox, 'fail-start'), '');
  await api(`${route}/config-options/permission_mode`, 'PUT', { value: 'default' }, [502]);
  await expect.poll(() => fs.existsSync(path.join(sandbox, 'downgrade-fault.json')), { timeout: 10000 }).toBe(true);
  const fault = JSON.parse(fs.readFileSync(path.join(sandbox, 'downgrade-fault.json')));
  assert.equal(fault.forwarded, false);
  checks.push('failed_yolo_to_ask_rpc_injected_after_adapter_downgrade_before_native_dispatch');
  await api(`${route}/runtime/restart`, 'POST', undefined, [502]);
  const startup = JSON.parse(fs.readFileSync(path.join(sandbox, 'startup-fault.json')));
  assert.deepEqual(startup, { nativeStarted: false, mode: 'default' });
  checks.push('fail_start_blocks_native_rebuild_with_saved_ask');
  const failedPort = port;
  await app.close();
  app = null;
  await assert.rejects(fetch(`http://127.0.0.1:${failedPort}/api/assistants`, { signal: AbortSignal.timeout(2000) }));
  fs.unlinkSync(path.join(sandbox, 'fail-start'));
  await launch(conv.id, 'SYNTHETIC_UI_YOLO');
  assert.notEqual(appPids.at(-2), appPids.at(-1));
  await api(`${route}/runtime/ensure`, 'POST');
  await expect(selector).toHaveAttribute('data-current-mode', 'default', { timeout: 30000 });
  await expect(selector).toContainText(/Default|기본값|Ask/);
  checks.push('failed_downgrade_full_app_host_restart_restores_ask_without_replaying_cached_yolo');
  let turn = await toolPrompt('SYNTHETIC_UI_ASK_RECOVERY');
  await consent();
  await page.screenshot({ path: path.join(output, 'ask-after-failure.png') });
  await api(`${route}/cancel`, 'POST', { turn_id: turn.turn_id });
  await idle();
  assert.equal(fs.existsSync(target), false);
  checks.push('ask_requires_consent_without_write', 'cancel_pending_consent_without_write');
  if (executablePath) {
    const observer = JSON.parse(process.env.RECOVERY_OBSERVER_ARGS);
    const code = `import sqlite3,json\nfrom pathlib import Path\nok=False\nfor file in Path(${JSON.stringify(sandbox)}).rglob('aionui-backend.db'):\n try:\n  with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:\n   row=db.execute('SELECT session_config FROM acp_session WHERE conversation_id = ?',(${JSON.stringify(conv.id)},)).fetchone()\n  r=json.loads(row[0]).get('runtime',{}) if row else {}\n  ok=ok or (r.get('current_mode_id')=='default' and r.get('config_selections',{}).get('permission_mode')=='default')\n except sqlite3.Error: pass\nprint(json.dumps(ok))`;
    await expect
      .poll(
        () => {
          const result = spawnSync(observer[0], [...observer.slice(1), 'helper', '-c', code], {
            encoding: 'utf8',
            env: appEnv,
            timeout: 10000,
          });
          assert.equal(result.status, 0, 'Installed isolated SQLite observer failed');
          return JSON.parse(result.stdout.trim());
        },
        { timeout: 20000 }
      )
      .toBe(true);
    checks.push('installed_ask_and_permission_config_observed_in_host_sqlite');
    const oldPort = port;
    await app.close();
    app = null;
    await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/api/assistants`, { signal: AbortSignal.timeout(2000) }));
    await launch(conv.id);
    assert.notEqual(appPids.at(-2), appPids.at(-1));
    await api(`${route}/runtime/ensure`, 'POST');
    await expect(selector).toHaveAttribute('data-current-mode', 'default', { timeout: 30000 });
    await expect(selector).toContainText(/Default|기본값|Ask/);
    turn = await toolPrompt('SYNTHETIC_UI_FULL_PROCESS_RELOAD');
    await consent();
    await api(`${route}/cancel`, 'POST', { turn_id: turn.turn_id });
    await idle();
    assert.equal(fs.existsSync(target), false);
    const messages = await api(`${route}/messages`);
    assert.ok(JSON.stringify(messages).includes('SYNTHETIC_UI_ASK_DENY'));
    assert.ok(JSON.stringify(messages).includes('SYNTHETIC_UI_YOLO'));
    checks.push(
      'installed_full_app_and_host_process_restart_restores_display_and_effective_ask',
      'installed_history_preserved_across_full_restart'
    );
  }
  await select('yolo');
  await toolPrompt('SYNTHETIC_UI_LATER_YOLO');
  await idle();
  assert.ok(fs.existsSync(target));
  assert.equal((await api(`${route}/confirmations`)).length, 0);
  checks.push('renderer_later_yolo_selector_and_actual_write');
  await select('default');
  checks.push('renderer_return_to_ask');
  fs.writeFileSync(
    path.join(output, 'renderer-result.json'),
    JSON.stringify(
      {
        checksPassed: checks,
        host: executablePath
          ? 'actual installed default host without backend override'
          : 'actual built Electron and explicit recovery candidate',
        driverNodeVersion: process.version,
        electronVersions: await app.evaluate(() => process.versions),
        appPids,
        displayedModeAfterRestore: 'default',
        actualApprovalAfterRestore: 'ask',
        unapprovedWriteObserved: false,
      },
      null,
      2
    ) + '\n'
  );
} catch (error) {
  if (conversationRoute)
    fs.writeFileSync(
      path.join(output, 'failure-wire.local'),
      JSON.stringify(await api(conversationRoute + '/messages').catch(() => []))
    );
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    fs.writeFileSync(
      path.join(output, 'failure-dom.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    );
  }
  throw error;
} finally {
  await app?.close();
}
