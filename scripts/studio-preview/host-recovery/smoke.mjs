import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const sandbox = process.env.RECOVERY_SANDBOX;
const output = process.env.RECOVERY_OUTPUT;
assert.ok(sandbox && output, 'Run through smoke.py with isolated synthetic state');
const app = await electron.launch({ args: ['.'], cwd: process.cwd(), env: process.env, timeout: 60_000 });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(1);
  });
}
let page;
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60_000 });
  const port = await page.evaluate(() => window.__backendPort);
  async function api(route, method = 'GET', body, status = [200, 201, 202]) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(status.includes(response.status), `${route}: HTTP ${response.status}`);
    const result = await response.json();
    return result.data ?? result;
  }
  await api('/api/agents/custom', 'POST', {
    name: 'Permission recovery synthetic ACP',
    command: process.env.RECOVERY_ADAPTER,
    args: [
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
  await api(`${route}/runtime/ensure`, 'POST');
  await page.evaluate((id) => {
    window.location.hash = `/conversation/${id}`;
  }, conv.id);
  const selector = page.getByTestId('mode-selector');
  await expect(selector).toHaveAttribute('data-current-mode', 'default', { timeout: 30_000 });
  async function select(mode) {
    await selector.click();
    await page.getByTestId(`aionrs-mode-option-${mode}`).click();
    await expect(selector).toHaveAttribute('data-current-mode', mode, { timeout: 30_000 });
  }
  async function idle() {
    await expect
      .poll(async () => (await api(`${route}/runtime/ensure`, 'POST')).runtime.state, { timeout: 30_000 })
      .toBe('idle');
  }
  const target = path.join(sandbox, 'workspace', 'renderer-write.txt');
  async function toolPrompt(text) {
    fs.writeFileSync(
      path.join(sandbox, 'tool-request.json'),
      JSON.stringify(['write', { path: target, content: 'synthetic' }])
    );
    return await api(`${route}/messages`, 'POST', { content: text });
  }
  await select('yolo');
  await toolPrompt('SYNTHETIC_UI_YOLO');
  await idle();
  assert.ok(fs.existsSync(target));
  assert.equal((await api(`${route}/confirmations`)).length, 0);
  fs.unlinkSync(target);
  fs.writeFileSync(path.join(sandbox, 'fail-start'), '');
  await api(`${route}/config-options/mode`, 'PUT', { value: 'default' }, [502]);
  fs.unlinkSync(path.join(sandbox, 'fail-start'));
  // Use the existing UI owner so its normal config revalidation also runs.
  await page.getByRole('button', { name: /^(Reconnect agent|에이전트 다시 연결)$/ }).click();
  await page.getByRole('button', { name: /^(Confirm|확인)$/ }).click();
  await expect(selector).toHaveAttribute('data-current-mode', 'default', { timeout: 30_000 });
  await expect(selector).toContainText(/Default|기본값|Ask/);
  const turn = await toolPrompt('SYNTHETIC_UI_ASK_RECOVERY');
  await expect.poll(async () => (await api(`${route}/confirmations`)).length, { timeout: 20_000 }).toBe(1);
  assert.equal(fs.existsSync(target), false);
  // Rendered tool consent must be visible as well as present on the host wire.
  await expect(page.getByTestId('message-acp-permission-option-allow-once')).toBeVisible();
  await expect(page.getByTestId('message-acp-permission-option-reject-once')).toBeVisible();
  await page.screenshot({ path: path.join(output, 'ask-after-failure.png') });
  await api(`${route}/cancel`, 'POST', { turn_id: turn.turn_id });
  await idle();
  assert.equal(fs.existsSync(target), false);
  await select('yolo');
  await toolPrompt('SYNTHETIC_UI_LATER_YOLO');
  await idle();
  assert.ok(fs.existsSync(target));
  assert.equal((await api(`${route}/confirmations`)).length, 0);
  await select('default');
  fs.writeFileSync(
    path.join(output, 'renderer-result.json'),
    JSON.stringify(
      {
        checksPassed: [
          'renderer_starts_ask',
          'renderer_yolo_selector_and_actual_write',
          'failed_downgrade_runtime_recovery_renders_ask',
          'recovered_ask_requires_consent_without_write',
          'cancel_pending_consent_without_write',
          'renderer_later_yolo_selector_and_actual_write',
          'renderer_return_to_ask',
        ],
        host: 'actual built Electron renderer and source-pinned AionCore recovery candidate',
        driverNodeVersion: process.version,
        electronVersions: await app.evaluate(() => process.versions),
        displayedModeAfterFailure: 'default',
        actualApprovalAfterFailure: 'ask',
        unapprovedWriteObserved: false,
      },
      null,
      2
    ) + '\n'
  );
} catch (error) {
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
  await app.close();
}
