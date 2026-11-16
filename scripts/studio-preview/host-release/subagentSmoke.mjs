/** Actual Electron + released host + bundled native delegation, with a loopback model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { _electron as electron, expect } from '@playwright/test';

const option = (name) => {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0, `Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
};
const runtime = option('--runtime');
const prepared = option('--prepared');
const output = option('--output');
fs.mkdirSync(output, { recursive: true });
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-subagents-'));
for (const name of ['home', 'agent/agents', 'workspace', 'extensions'])
  fs.mkdirSync(path.join(sandbox, name), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'workspace/evidence.txt'), 'Reviewed evidence from an actual native read tool.');
fs.writeFileSync(
  path.join(sandbox, 'agent/agents/reviewer.md'),
  '---\nname: reviewer\ndescription: Synthetic subagent probe\ntools: [read, bash]\n---\nFollow the synthetic task.\n'
);
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inventory = () => {
  const result = {};
  for (const entry of fs.readdirSync(runtime, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    if (entry.isFile() || entry.isSymbolicLink())
      result[path.relative(runtime, file)] = entry.isSymbolicLink() ? `symlink:${fs.readlinkSync(file)}` : digest(file);
  }
  return result;
};
const before = inventory();
const holds = new Map();
const calls = new Map();
let sequence = 0;
let resumeTarget;
let requestCount = 0;
const event = (delta, finish) =>
  'data: ' +
  JSON.stringify({
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'one',
    choices: [{ index: 0, delta, finish_reason: finish }],
    usage: { prompt_tokens: 17, completion_tokens: 3, total_tokens: 20 },
  }) +
  '\n\n';
const model = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  const index = ++requestCount;
  const messages = request.messages;
  const last = messages.at(-1);
  const user = JSON.stringify(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '');
  const tool = (name, args, id) => ({
    role: 'assistant',
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  });
  let delta = { role: 'assistant', content: 'PARENT_DONE' };
  let finish = 'stop';
  if (user.includes('CHILD_FAIL')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'SYNTHETIC_CHILD_FAILURE', type: 'invalid_request_error' } }));
    return;
  }
  if (user.includes('CHILD_RESUME')) {
    delta.content = 'RESUMED_CHILD_WORK';
  } else if (/CHILD_(COMPLETE|CANCEL)_[AB]/.test(user)) {
    const child = /CHILD_(?:COMPLETE|CANCEL)_[AB]/.exec(user)[0];
    if (last.role === 'user') {
      delta = tool('read', { path: path.join(sandbox, 'workspace/evidence.txt') }, `read-${index}`);
      finish = 'tool_calls';
    } else if (last.role === 'tool' && last.tool_call_id.startsWith('read-')) {
      delta = tool('bash', { command: 'sleep 2' }, `bash-${index}`);
      delta.content = `PARTIAL_${child}: reviewed evidence.`;
      finish = 'tool_calls';
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(event({ role: 'assistant', content: `PARTIAL_${child}: reviewed evidence.` }, null));
      holds.set(child, res);
      res.on('close', () => holds.delete(child));
      return;
    }
  } else if (last.role === 'user') {
    const marker = ['STUDIO31_RUN', 'STUDIO31_CANCEL', 'STUDIO31_RESUME', 'STUDIO31_FAIL'].find((name) =>
      user.includes(name)
    );
    if (marker) {
      const id = `agent-${++sequence}`;
      calls.set(marker, id);
      if (marker === 'STUDIO31_RESUME') {
        // The model receives native's queued cancellation report on the next user turn.
        const sessions = [...JSON.stringify(messages).matchAll(/[Ss]ession[: ]+([a-f0-9-]{36})/g)];
        resumeTarget = sessions.at(-1)?.[1];
        assert.ok(resumeTarget, 'Native cancellation context did not identify a resumable child');
      }
      const args =
        marker === 'STUDIO31_RESUME'
          ? {
              action: 'resume',
              profile: 'reviewer',
              id: resumeTarget,
              task: 'CHILD_RESUME finish the interrupted work',
            }
          : marker === 'STUDIO31_FAIL'
            ? { profile: 'reviewer', task: 'CHILD_FAIL respond' }
            : {
                profile: 'reviewer',
                mode: 'parallel',
                tasks:
                  marker === 'STUDIO31_RUN'
                    ? ['CHILD_COMPLETE_A', 'CHILD_COMPLETE_B']
                    : ['CHILD_CANCEL_A', 'CHILD_CANCEL_B'],
              };
      delta = tool('agent', args, id);
      finish = 'tool_calls';
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(event(delta, null) + event({}, finish) + 'data: [DONE]\n\n');
});
await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
const modelPort = model.address().port;
fs.writeFileSync(
  path.join(sandbox, 'agent/models.json'),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        api: 'openai-completions',
        apiKey: 'synthetic-fixture-key',
        models: [{ id: 'one', name: 'one', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024 }],
      },
    },
  })
);
fs.writeFileSync(
  path.join(sandbox, 'agent/settings.json'),
  JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one' })
);
const env = {
  PATH: process.env.PATH,
  HOME: path.join(sandbox, 'home'),
  AELIX_CODING_AGENT_DIR: path.join(sandbox, 'agent'),
  AELIX_CODING_AGENT_SESSION_DIR: path.join(sandbox, 'sessions'),
  AELIX_SETTINGS_PATH: path.join(sandbox, 'agent/settings.json'),
  AELIX_AUTH_PATH: path.join(sandbox, 'agent/auth.json'),
  PYTHONDONTWRITEBYTECODE: '0',
  AIONUI_E2E_TEST: '1',
  AIONUI_E2E_USER_DATA_DIR: path.join(sandbox, 'studio'),
  AIONUI_BACKEND_BIN: path.join(prepared, 'aioncore/aelix-studio-host'),
  AIONUI_BUNDLED_MANAGED_RESOURCES: path.join(prepared, 'aioncore/managed-resources'),
  AELIX_STUDIO_RUNTIME: runtime,
  AIONUI_DISABLE_DEVTOOLS: '1',
  AIONUI_DISABLE_AUTO_UPDATE: '1',
  AIONUI_CDP_PORT: '0',
  AIONUI_EXTENSIONS_PATH: path.join(sandbox, 'extensions'),
  AIONUI_EXTENSION_STATES_FILE: path.join(sandbox, 'extension-states.json'),
};
let app, page, port, route;
const checks = [];
const snapshots = {};
const report = {
  status: 'failed',
  provider: 'synthetic loopback',
  realProvider: false,
  installer: false,
  host: 'host-v0.2.2-aelix.4',
  sandbox,
  checks,
};
async function api(suffix, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${port}${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  assert.ok(response.ok, `${suffix}: ${response.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data.data ?? data;
}
const idle = () =>
  expect
    .poll(async () => (await api(`${route}/runtime/ensure`, 'POST')).runtime.state, { timeout: 30000 })
    .toBe('idle');
const card = (marker) => page.locator(`[data-tool-call-id="${calls.get(marker)}"]`);
async function send(marker) {
  await page.getByTestId('sendbox-input').fill(marker);
  await page.getByTestId('sendbox-send-btn').click();
  await expect.poll(() => calls.get(marker), { timeout: 30000 }).toBeTruthy();
}
async function capture(marker) {
  const row = (await api(`${route}/messages?limit=100`)).items.find(
    (item) => item.type === 'acp_tool_call' && item.content.update.tool_call_id === calls.get(marker)
  );
  assert.ok(row);
  snapshots[marker] = row.content;
  return row.content;
}
try {
  app = await electron.launch({ args: ['.'], cwd: process.cwd(), env, timeout: 60000 });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  port = await page.evaluate(() => window.__backendPort);
  await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
  await api('/api/agents/custom', 'POST', {
    name: 'Subagent smoke',
    command: path.join(runtime, 'python/bin/python3'),
    args: [
      '-I',
      '-S',
      '-B',
      path.join(runtime, 'launch.py'),
      'acp',
      '--state-dir',
      path.join(sandbox, 'acp'),
      '--enable-agents',
      '--permission-mode',
      'yolo',
    ],
    env: [],
    icon: 'S',
  });
  const assistant = (await api('/api/assistants')).find((item) => item.name === 'Subagent smoke');
  const conversation = await api('/api/conversations', 'POST', {
    name: 'Subagent UI acceptance',
    assistant: { id: assistant.id },
    extra: { workspace: path.join(sandbox, 'workspace'), custom_workspace: true },
  });
  route = `/api/conversations/${conversation.id}`;
  await api(`${route}/runtime/ensure`, 'POST');
  await api(`${route}/config-options/autoRetryEnabled`, 'PUT', { value: 'false' });
  await page.evaluate((id) => {
    window.location.hash = `/conversation/${id}`;
  }, conversation.id);
  await expect(page.getByTestId('sendbox-input')).toBeVisible({ timeout: 30000 });
  await send('STUDIO31_RUN');
  await expect(card('STUDIO31_RUN').locator('[data-subagent-state="running"]')).toHaveCount(2, { timeout: 30000 });
  await expect(card('STUDIO31_RUN')).toContainText(/bash/);
  checks.push('two_children_live_state_and_current_tool');
  await expect.poll(() => holds.size, { timeout: 30000 }).toBe(2);
  for (const response of [...holds.values()]) response.end(event({}, 'stop') + 'data: [DONE]\n\n');
  await idle();
  await expect(card('STUDIO31_RUN').locator('[data-subagent-state="done"]')).toHaveCount(2);
  await capture('STUDIO31_RUN');
  checks.push('completed_children_usage_and_cost');
  await page.screenshot({ path: path.join(output, 'completed.png') });

  await send('STUDIO31_CANCEL');
  await expect.poll(() => holds.size, { timeout: 30000 }).toBe(2);
  await page.waitForTimeout(500);
  await page.locator('.sendbox-stop-button').click();
  await idle();
  await expect(card('STUDIO31_CANCEL').locator('[data-subagent-state="stopped"]')).toHaveCount(2, { timeout: 30000 });
  report.partialResultVisible = (await card('STUDIO31_CANCEL').textContent()).includes('PARTIAL_CHILD_CANCEL');
  const stopped = await capture('STUDIO31_CANCEL');
  checks.push('ui_cancel_stops_children');
  if (report.partialResultVisible) checks.push('ui_cancel_displays_partial_work');
  await page.screenshot({ path: path.join(output, 'stopped.png') });

  await send('STUDIO31_RESUME');
  await idle();
  await expect(card('STUDIO31_RESUME').locator('[data-subagent-state="done"]')).toHaveCount(1, { timeout: 30000 });
  const resumed = await capture('STUDIO31_RESUME');
  assert.equal(resumed.update.raw_input.action, 'resume');
  assert.equal(resumed.update.raw_input.id, resumeTarget);
  assert.ok(
    stopped._meta['aelix/subagents'].children.every(
      (child) => child.id !== resumed._meta['aelix/subagents'].children[0].id
    )
  );
  checks.push('chat_requested_stopped_child_resume_in_new_call');

  await send('STUDIO31_FAIL');
  await idle();
  await expect(card('STUDIO31_FAIL').locator('[data-subagent-state="error"]')).toHaveCount(1, { timeout: 30000 });
  await capture('STUDIO31_FAIL');
  checks.push('native_child_failure_visible');
  await page.reload();
  await expect(page.getByTestId('sendbox-input')).toBeVisible({ timeout: 30000 });
  await expect(card('STUDIO31_FAIL').locator('[data-subagent-state="error"]')).toHaveCount(1, { timeout: 30000 });
  await expect(card('STUDIO31_RESUME').locator('[data-subagent-state="done"]')).toHaveCount(1);
  await card('STUDIO31_CANCEL').scrollIntoViewIfNeeded();
  await expect(card('STUDIO31_CANCEL').locator('[data-subagent-state="stopped"]')).toHaveCount(2);
  checks.push('reload_restores_metadata');
  if (report.partialResultVisible) await expect(card('STUDIO31_CANCEL')).toContainText('PARTIAL_CHILD_CANCEL');
  await page.screenshot({ path: path.join(output, 'restored.png') });
  await app.close();
  app = null;
  assert.deepEqual(inventory(), before, 'Delegation changed the immutable bundled runtime');
  execFileSync(
    process.execPath,
    ['scripts/studio-preview/packaging/build.mjs', '--runtime', prepared, '--payload', runtime, '--verify-only'],
    { stdio: 'pipe' }
  );
  checks.push('post_delegation_strict_inventory_unchanged');
  assert.ok(report.partialResultVisible, 'Stopped-child partial work is absent from the parent tool result');
  report.status = 'passed';
} catch (error) {
  report.error = String(error);
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
  if (route)
    fs.writeFileSync(
      path.join(output, 'failure-messages.json'),
      JSON.stringify(await api(`${route}/messages?limit=100`).catch(() => []), null, 2)
    );
  throw error;
} finally {
  await app?.close();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  report.providerRequests = requestCount;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'frames.json'), JSON.stringify(snapshots, null, 2) + '\n');
}
process.stdout.write(JSON.stringify({ status: report.status, checks: checks.length }) + '\n');
