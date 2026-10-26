import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const sandbox = process.env.FORWARD_SANDBOX;
const output = process.env.FORWARD_OUTPUT;
assert.ok(sandbox && output, 'Run through smoke.py with isolated state');
const executablePath = process.env.FORWARD_APP_EXECUTABLE;
const appEnv = { ...process.env };
if (executablePath) {
  for (const name of ['AIONUI_BACKEND_BIN', 'AELIX_STUDIO_RUNTIME', 'AIONUI_BUNDLED_MANAGED_RESOURCES'])
    delete appEnv[name];
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
let page;
const checks = [];
const submitted = [];
try {
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  assert.equal(await page.evaluate(() => typeof navigator.locks?.request), 'function');
  checks.push('actual_electron_origin_supports_cross_window_web_locks');
  const port = await page.evaluate(() => window.__backendPort);
  async function api(route, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    assert.ok(response.ok, `Qualification HTTP ${response.status}`);
    const result = await response.json();
    return result.data ?? result;
  }
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/messages$/.test(new URL(request.url()).pathname))
      submitted.push(request.postDataJSON()?.operation);
  });
  await api('/api/agents/custom', 'POST', {
    name: 'Forwarding UI synthetic ACP',
    command: process.env.FORWARD_COMMAND,
    args: JSON.parse(process.env.FORWARD_ARGS),
    env: [],
    icon: '🧪',
  });
  const assistant = (await api('/api/assistants')).find((item) => item.name === 'Forwarding UI synthetic ACP');
  assert.ok(assistant);
  const conv = await api('/api/conversations', 'POST', {
    name: 'Forwarding qualification',
    assistant: { id: assistant.id },
    extra: { workspace: path.join(sandbox, 'workspace'), custom_workspace: true },
  });
  const route = `/api/conversations/${conv.id}`;
  const ready = await api(`${route}/runtime/ensure`, 'POST');
  assert.equal(ready.operation_capability.schema, 'aelix.operation/1');
  async function envelope() {
    return await page.evaluate((id) => {
      const key = Object.keys(localStorage).find(
        (key) => key.startsWith('aelix-managed-operation/') && key.endsWith(`/${encodeURIComponent(id)}`)
      );
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    }, conv.id);
  }
  async function completed(id) {
    await expect
      .poll(
        async () => {
          const stored = await envelope();
          if (!stored || (id && stored.operation.id !== id)) return 'missing';
          return (
            await api(`${route}/operations/${stored.operation.id}?host_store_id=${stored.operation.host_store_id}`)
          ).state;
        },
        { timeout: 30000 }
      )
      .toBe('completed');
  }
  await page.evaluate(
    ({ id }) => {
      sessionStorage.setItem(`acp_initial_message_${id}`, JSON.stringify({ input: 'SYNTHETIC_INITIAL', files: [] }));
      window.location.hash = `/conversation/${id}`;
    },
    { id: conv.id }
  );
  await completed(`initial-${conv.id}`);
  checks.push('actual_initial_send_keeps_deterministic_conversation_operation');
  const initial = await envelope();
  await page.evaluate(
    ({ id }) =>
      sessionStorage.setItem(`acp_initial_message_${id}`, JSON.stringify({ input: 'SYNTHETIC_INITIAL', files: [] })),
    { id: conv.id }
  );
  await page.reload();
  await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 30000 });
  await expect
    .poll(() => page.evaluate((id) => sessionStorage.getItem(`acp_initial_message_${id}`), conv.id))
    .toBe(null);
  assert.equal(submitted.length, 1);
  assert.deepEqual((await envelope()).operation, initial.operation);
  checks.push('restored_initial_intent_reconciles_without_second_http_submission');
  const input = page.locator('textarea:visible').last();
  await input.fill('SYNTHETIC_ORDINARY');
  await input.press('Enter');
  await expect.poll(async () => (await envelope())?.operation.id).not.toBe(initial.operation.id);
  await completed();
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every((key) => key?.schema === 'aelix.operation/1'));
  checks.push('existing_sendbox_submits_managed_operation_without_unkeyed_fallback');
  const ordinary = await envelope();
  await page.reload();
  await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 30000 });
  await completed(ordinary.operation.id);
  assert.equal(submitted.length, 2);
  checks.push('actual_renderer_reload_recovers_original_status_without_resubmission');
  let loseQueueAck = true;
  await page.route(`**${route}/messages`, async (intercept) => {
    if (intercept.request().method() !== 'POST' || !loseQueueAck) return intercept.continue();
    loseQueueAck = false;
    const response = await intercept.fetch();
    assert.equal(response.status(), 202);
    await intercept.abort('failed');
  });
  await page.evaluate(
    ({ id }) => {
      sessionStorage.setItem(
        `conversation-command-queue/${id}`,
        JSON.stringify({
          mode: 'auto',
          isPaused: false,
          items: [{ id: 'qualified-queue-operation', input: 'SYNTHETIC_QUEUE', files: [], created_at: Date.now() }],
        })
      );
    },
    { id: conv.id }
  );
  await page.reload();
  await completed('qualified-queue-operation');
  await expect.poll(() => submitted.length).toBe(3);
  await page.reload();
  await expect(page.getByTestId('mode-selector')).toBeVisible({ timeout: 30000 });
  await completed('qualified-queue-operation');
  assert.equal(submitted.length, 3);
  checks.push('actual_queue_ack_loss_and_remount_preserve_original_key_without_replay');
  assert.equal(JSON.stringify(await envelope()).includes('SYNTHETIC_'), false);
  checks.push('renderer_operation_envelope_contains_no_prompt_or_credentials');
  await page.screenshot({ path: path.join(output, 'managed-forwarding.png') });
  fs.writeFileSync(
    path.join(output, 'renderer-result.json'),
    JSON.stringify(
      {
        checksPassed: checks,
        driverNodeVersion: process.version,
        electronVersions: await app.evaluate(() => process.versions),
        host: executablePath ? 'actual installed default host' : 'built Electron with explicit source host',
        httpSubmissions: submitted.length,
      },
      null,
      2
    ) + '\n'
  );
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  if (page)
    fs.writeFileSync(
      path.join(output, 'failure-dom.local'),
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    );
  throw error;
} finally {
  await app.close();
}
