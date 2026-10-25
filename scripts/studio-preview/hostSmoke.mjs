import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';

const runtime = process.env.PREVIEW_RUNTIME;
const sandbox = process.env.PREVIEW_SANDBOX;
assert.ok(runtime && sandbox, 'Run through smoke.py to isolate auth and model requests');
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
  async function api(route, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    const result = await response.json();
    return result.data ?? result;
  }
  const agent = await api('/api/agents/custom', 'POST', {
    name: 'Aelix Preview qualification',
    command: 'node',
    args: [
      path.join(runtime, 'launch.cjs'),
      '--profile',
      'coding',
      '--state-dir',
      path.join(sandbox, 'acp'),
      '--provider',
      'fixture',
      '--model',
      'one',
    ],
    env: [],
    icon: '🧬',
    advanced: { description: 'Isolated Studio #4 qualification' },
  });
  assert.ok(agent.id);
  const assistants = await api('/api/assistants');
  const assistant = assistants.find((item) => item.name === 'Aelix Preview qualification');
  assert.ok(assistant, 'Existing custom-agent registration must create an assistant');
  const conversation = await api('/api/conversations', 'POST', {
    name: 'Public beta.2 baseline',
    assistant: { id: assistant.id },
    extra: { workspace: path.join(sandbox, 'workspace'), custom_workspace: true },
  });
  const observed = await api(`/api/conversations/${conversation.id}/runtime/ensure`, 'POST');
  fs.writeFileSync(path.join(runtime, 'runtime-observed.json'), JSON.stringify(observed, null, 2) + '\n');
  const options = observed.config_options ?? [];
  const model = options.find((item) => item.id === 'model');
  assert.ok(model, 'AionCore must translate the legacy ACP model selector');
  assert.equal(model.current_value, 'fixture/one');
  assert.equal(model.options.length, 1, 'Do not claim live model switching');
  assert.equal(
    options.some((item) => /thinking|reasoning/i.test(item.id)),
    false
  );
  await page.evaluate((id) => {
    window.location.hash = `/conversation/${id}`;
  }, conversation.id);
  const selector = page.getByTestId('acp-model-selector');
  await expect(selector).toContainText('one', { timeout: 30_000 });
  await selector.click();
  const modelItem = page.getByText('one', { exact: true }).last();
  await expect(modelItem).toBeVisible();
  await modelItem.click();
  await page.keyboard.press('Escape');
  const unsupported = await fetch(
    `http://127.0.0.1:${port}/api/conversations/${conversation.id}/config-options/model`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'fixture/two' }),
      signal: AbortSignal.timeout(15_000),
    }
  );
  assert.equal(unsupported.status, 400, 'The host must reject a model absent from the launch-only selector');
  const input = page.getByTestId('sendbox-input');
  await input.fill('QUALIFICATION_STUDIO_SESSION');
  await page.getByTestId('sendbox-send-btn').click();
  await expect(page.getByTestId('message-text-left').filter({ hasText: 'QUALIFICATION_OK' })).toBeVisible({
    timeout: 30_000,
  });
  await input.fill('QUALIFICATION_HOLD');
  await page.getByTestId('sendbox-send-btn').click();
  const stop = page.locator('.sendbox-stop-button');
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => fs.existsSync(path.join(sandbox, 'provider-held')), { timeout: 15_000 }).toBe(true);
  await stop.click();
  await expect(stop).toBeHidden({ timeout: 15_000 });
  const current = await api(`/api/conversations/${conversation.id}/runtime/ensure`, 'POST');
  assert.equal(current.config_options.find((item) => item.id === 'model').current_value, 'fixture/one');
  await page.screenshot({ path: path.join(runtime, 'studio-session.png') });
  fs.writeFileSync(
    path.join(runtime, 'host-smoke.json'),
    JSON.stringify(
      {
        status: 'pending_provider_audit',
        host: 'actual built Electron renderer and AionCore',
        checks: [
          'custom_agent_registration',
          'basic_session',
          'launch_model_selector',
          'host_unavailable_model_rejected',
          'ui_text_stream',
          'ui_stop',
        ],
        unsupportedModelHttpStatus: unsupported.status,
        configOptionIds: options.map((item) => item.id),
        liveModelSwitch: false,
        reasoningForwarded: false,
        contextForwarded: false,
      },
      null,
      2
    ) + '\n'
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(runtime, 'studio-failure.png') }).catch(() => {});
    fs.writeFileSync(
      path.join(runtime, 'failure-dom.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    );
    fs.writeFileSync(path.join(runtime, 'failure-dom.html'), await page.content().catch(() => ''));
  }
  throw error;
} finally {
  await app.close();
}
