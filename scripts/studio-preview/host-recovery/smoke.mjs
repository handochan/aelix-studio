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
let app, page, port, selector, conversationRoute;
const appPids = [],
  checks = [];
async function launch(conversation) {
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: executablePath ? sandbox : process.cwd(),
    env: appEnv,
    timeout: 60000,
  });
  appPids.push(await app.evaluate(() => process.pid));
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  port = await page.evaluate(() => window.__backendPort);
  if (executablePath) assert.equal(await app.evaluate(() => process.env.AIONUI_BACKEND_BIN), undefined);
  // Backend readiness precedes the authenticated startup router. Wait for its
  // Guid surface before navigating so an initial redirect cannot replace us.
  await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
  if (conversation) {
    await page.locator(`[id="c-${conversation}"]`).click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash), { timeout: 30000 })
      .toBe(`#/conversation/${conversation}`);
    await expect(page.getByTestId('message-list-content')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('message-text-content').filter({ hasText: 'SYNTHETIC_UI_ASK_RECOVERY' })).toBeVisible(
      { timeout: 30000 }
    );
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
  const conv = await api('/api/conversations', 'POST', {
    name: 'Permission recovery',
    assistant: { id: assistant.id },
    extra: { workspace: path.join(sandbox, 'workspace'), custom_workspace: true },
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
  fs.writeFileSync(path.join(sandbox, 'fail-start'), '');
  await api(`${route}/config-options/mode`, 'PUT', { value: 'default' }, [502]);
  fs.unlinkSync(path.join(sandbox, 'fail-start'));
  await page.getByRole('button', { name: /^(Reconnect agent|에이전트 다시 연결)$/ }).click();
  await page.getByRole('button', { name: /^(Confirm|확인)$/ }).click();
  await expect(selector).toHaveAttribute('data-current-mode', 'default', { timeout: 30000 });
  await expect(selector).toContainText(/Default|기본값|Ask/);
  checks.push('failed_downgrade_runtime_recovery_renders_ask');
  let turn = await toolPrompt('SYNTHETIC_UI_ASK_RECOVERY');
  await consent();
  await page.screenshot({ path: path.join(output, 'ask-after-failure.png') });
  await api(`${route}/cancel`, 'POST', { turn_id: turn.turn_id });
  await idle();
  assert.equal(fs.existsSync(target), false);
  checks.push('recovered_ask_requires_consent_without_write', 'cancel_pending_consent_without_write');
  if (executablePath) {
    const observer = JSON.parse(process.env.RECOVERY_OBSERVER_ARGS);
    const code = `import sqlite3,json\nfrom pathlib import Path\nok=False\nfor file in Path(${JSON.stringify(sandbox)}).rglob('aionui-backend.db'):\n try:\n  with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:\n   row=db.execute('SELECT session_config FROM acp_session WHERE conversation_id = ?',(${JSON.stringify(conv.id)},)).fetchone()\n  r=json.loads(row[0]).get('runtime',{}) if row else {}\n  ok=ok or (r.get('current_mode_id')=='default' and r.get('config_selections',{}).get('mode')!='yolo')\n except sqlite3.Error: pass\nprint(json.dumps(ok))`;
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
    checks.push('installed_recovered_ask_and_cleaned_config_observed_in_host_sqlite');
    const oldPort = port;
    await app.close();
    app = null;
    await assert.rejects(fetch(`http://127.0.0.1:${oldPort}/api/assistants`, { signal: AbortSignal.timeout(2000) }));
    await launch(conv.id);
    assert.notEqual(appPids[0], appPids[1]);
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
        displayedModeAfterFailure: 'default',
        actualApprovalAfterFailure: 'ask',
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
