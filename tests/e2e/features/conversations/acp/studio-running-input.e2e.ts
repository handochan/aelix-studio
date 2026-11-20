import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, chromium, expect, test, type Page } from '@playwright/test';
import { BackendLifecycleManager, fetchStudioBackend, startStaticServer } from '@aionui/web-host';
import { build } from 'esbuild';
import type {
  createRunningInputClient,
  prepareRunningInputMessage,
} from '../../../../../packages/desktop/src/renderer/services/runtime/RunningInput';

type RelayWindow = Window & {
  RunningInput: {
    createRunningInputClient: typeof createRunningInputClient;
    prepareRunningInputMessage: typeof prepareRunningInputMessage;
  };
  runningInput: ReturnType<typeof createRunningInputClient>;
  __backendPort?: number;
};

const hostBinary = process.env.STUDIO_RUNNING_INPUT_HOST;
const adapterBinary = process.env.STUDIO_RUNNING_INPUT_ACP;
const nativeBinary = process.env.STUDIO_RUNNING_INPUT_NATIVE;
const agentId = 'fixture-running-input';
const steerText = 'RUNNING_INPUT_STEER_MARKER';
const followUpText = 'RUNNING_INPUT_FOLLOW_UP_MARKER';
const staleText = 'RUNNING_INPUT_STALE_MARKER';

const sqlString = (value: string) => "'" + value.replaceAll("'", "''") + "'";

function seedBuiltin(root: string, adapter: string, native: string): void {
  // The released H1 host enables the relay only for an unmodified builtin catalog entry.
  // Seed the isolated catalog before startup hydration, using the installed ACP and native.
  const args = JSON.stringify([
    '--aelix',
    native,
    '--profile',
    'coding',
    '--provider',
    'fixture',
    '--model',
    'one',
    '--state-dir',
    join(root, 'acp'),
  ]);
  execFileSync('sqlite3', [
    join(root, 'aionui-backend.db'),
    `
    INSERT INTO agent_metadata (id, agent_id, name, backend, agent_type, agent_source, command, args, created_at, updated_at)
    VALUES ('${agentId}','${agentId}','Running Input','aelix','acp','builtin',${sqlString(adapter)},${sqlString(args)},1,1);
  `,
  ]);
}

async function prepareFixture(root: string) {
  const agent = join(root, 'agent');
  const workspace = join(root, 'workspace');
  const site = join(root, 'site');
  await Promise.all([agent, workspace, site].map((dir) => mkdir(dir)));
  let releaseTurn!: () => void;
  const holdTurn = new Promise<void>((done) => {
    releaseTurn = done;
  });
  const prompts: string[] = [];
  const modelUserTexts: string[] = [];
  const model = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString()) as {
        messages: { role: string; content: string | { type: string; text?: string }[] }[];
      };
      prompts.push(JSON.stringify(request.messages));
      const lastUser = request.messages.filter(({ role }) => role === 'user').at(-1)?.content;
      modelUserTexts.push(
        typeof lastUser === 'string'
          ? lastUser
          : (lastUser
              ?.filter(({ type }) => type === 'text')
              .map(({ text }) => text)
              .join('') ?? '')
      );
      await holdTurn;
      const chunk = (delta: object, finishReason: string | null) =>
        'data: ' +
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'one',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }) +
        '\n\n';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        chunk({ role: 'assistant', content: 'Fixture model answer' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'
      );
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
  const address = model.address();
  assert(address && typeof address !== 'string');
  const stop = async () => {
    releaseTurn();
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
  };

  try {
    await writeFile(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture-key',
            models: [{ id: 'one', name: 'Fixture', input: ['text'], contextWindow: 32768, maxTokens: 1024 }],
          },
        },
      })
    );
    await writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one' }));
    await writeFile(join(site, 'index.html'), '<!doctype html><title>Running input contract test</title>');
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      AELIX_CODING_AGENT_DIR: agent,
      AELIX_SETTINGS_PATH: join(agent, 'settings.json'),
      AELIX_AUTH_PATH: join(agent, 'auth.json'),
    };
    const bundle = await build({
      entryPoints: [resolve('packages/desktop/src/renderer/services/runtime/RunningInput/index.ts')],
      platform: 'browser',
      bundle: true,
      format: 'iife',
      globalName: 'RunningInput',
      define: { 'process.env.AIONUI_MULTI_INSTANCE': JSON.stringify('') },
      write: false,
    });
    const attachment = join(workspace, '첨부 자료.txt');
    await writeFile(attachment, 'Running-input attachment fixture');
    return {
      env,
      site,
      workspace,
      attachment,
      bundle: bundle.outputFiles[0].text,
      releaseTurn,
      prompts,
      modelUserTexts,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function api(page: Page, route: string, method = 'GET', payload?: object): Promise<unknown> {
  return page.evaluate(
    async (request) => {
      const port = (window as RelayWindow).__backendPort;
      const headers = new Headers({ 'content-type': 'application/json' });
      const cookie = document.cookie.split('; ').find((part) => part.startsWith('aelix-studio-csrf-token='));
      if (cookie) headers.set('x-csrf-token', cookie.slice(cookie.indexOf('=') + 1));
      const origin = port ? 'http://127.0.0.1:' + port : '';
      const response = await fetch(origin + request.route, {
        method: request.method,
        headers,
        ...(request.method === 'GET' || !request.payload ? {} : { body: JSON.stringify(request.payload) }),
      });
      const body = (await response.json()) as { data?: unknown; code?: string };
      if (!response.ok)
        throw new Error(`${request.method} ${request.route} returned ${response.status} ${body.code ?? ''}`);
      return body.data ?? body;
    },
    { route, method, payload }
  );
}

async function checkRunningInput(page: Page, fixture: Awaited<ReturnType<typeof prepareFixture>>) {
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  const conversation = (await api(page, '/api/conversations', 'POST', {
    type: 'acp',
    name: 'Running input contract',
    extra: {
      agent_id: agentId,
      backend: 'aelix',
      workspace: fixture.workspace,
      custom_workspace: true,
    },
  })) as { id: string };
  const mention = (await api(page, '/api/conversations', 'POST', {
    type: 'acp',
    name: 'Attachment target',
    extra: { agent_id: agentId, backend: 'aelix', workspace: fixture.workspace, custom_workspace: true },
  })) as { id: string };
  const route = '/api/conversations/' + conversation.id;
  await api(page, route + '/runtime/ensure', 'POST');
  await page.addScriptTag({ content: fixture.bundle });
  await page.evaluate((id) => {
    const win = window as RelayWindow;
    win.runningInput = win.RunningInput.createRunningInputClient(id);
  }, conversation.id);
  await api(page, route + '/messages', 'POST', { content: 'ORIGINAL_RUNNING_INPUT_PROMPT' });

  await expect.poll(() => fixture.prompts.length).toBe(1);
  const target = await page.evaluate(async () => {
    const client = (window as RelayWindow).runningInput;
    await client.refresh();
    const { channel } = client.getSnapshot();
    if (channel.status !== 'ready' || !channel.turn.active) throw new Error(JSON.stringify(channel));
    return { bindingId: channel.bindingId, turnId: channel.turn.turnId };
  });
  const receipts = await page.evaluate(
    async (input) => {
      const win = window as RelayWindow;
      const { text } = await win.RunningInput.prepareRunningInputMessage(input.conversationId, input.steerText, {
        files: [{ kind: 'local', path: input.attachment }],
        sessions: [{ id: input.mentionId }],
      });
      const steer = await win.runningInput.send('steer', input.target, text);
      const followUp = await win.runningInput.send('follow-up', input.target, input.followUpText);
      return { steer, followUp };
    },
    {
      target,
      steerText,
      followUpText,
      conversationId: conversation.id,
      attachment: fixture.attachment,
      mentionId: mention.id,
    }
  );
  expect(receipts).toMatchObject({
    steer: { status: 'sent', preserveDraft: false, receipt: { ...target, mode: 'steer', status: 'queued' } },
    followUp: { status: 'sent', preserveDraft: false, receipt: { ...target, mode: 'follow-up', status: 'queued' } },
  });

  fixture.releaseTurn();
  await expect
    .poll(
      async () => {
        const current = (await api(page, route)) as { runtime?: { state?: string; turn_id?: string | null } };
        return current.runtime;
      },
      { timeout: 25_000 }
    )
    .toMatchObject({ state: 'idle', turn_id: null });
  const stale = await page.evaluate(
    async (input) => {
      const client = (window as RelayWindow).runningInput;
      await client.refresh();
      return client.send('steer', input.target, input.message);
    },
    { target, message: staleText }
  );
  expect(stale).toMatchObject({
    status: 'sent',
    preserveDraft: true,
    receipt: { ...target, status: 'rejected', reason: 'stale-turn' },
  });
  const resolvedPath = await realpath(fixture.attachment);
  expect(fixture.modelUserTexts.find((value) => value.startsWith(steerText))).toBe(
    [
      steerText,
      '',
      '[[AION_SESSIONS]]',
      'To deliver to the conversations below, use the session-message skill (address by conversation id); if it is unavailable, run `"$AIONUI_HELPER_BIN" session capabilities` for the delivery contract.',
      `Attachment target\t${mention.id}\tworkspace: same`,
      '[[/AION_SESSIONS]]',
      '',
      '[[AION_FILES]]',
      resolvedPath,
    ].join('\n')
  );
  expect(fixture.prompts[0]).toContain('ORIGINAL_RUNNING_INPUT_PROMPT');
  expect(fixture.prompts.join()).not.toContain(staleText);
  const history = JSON.stringify(await api(page, route + '/messages'));
  for (const marker of [steerText, followUpText, staleText, fixture.attachment, resolvedPath]) {
    expect(consoleMessages.join()).not.toContain(marker);
    expect(history).not.toContain(marker);
  }
}

for (const surface of ['desktop', 'webui'] as const) {
  test(`running input receives native queue receipts on ${surface}`, async () => {
    test.skip(
      !hostBinary || !adapterBinary || !nativeBinary,
      'Supply the verified bundled host, ACP and native paths.'
    );
    test.skip(process.platform === 'win32', 'This fixture seeds the isolated host catalog with the sqlite3 CLI.');
    assert(hostBinary && adapterBinary && nativeBinary);
    const root = await mkdtemp(join(tmpdir(), 'studio-running-input-'));
    try {
      const fixture = await prepareFixture(root);
      try {
        if (surface === 'desktop') {
          const entry = join(root, 'electron.cjs');
          await build({
            entryPoints: [resolve('tests/e2e/helpers/studioBackendHarness.ts')],
            outfile: entry,
            bundle: true,
            platform: 'node',
            external: ['electron'],
          });
          const electron = await _electron.launch({ args: [entry, hostBinary, root], env: fixture.env });
          try {
            const page = await electron.firstWindow();
            await expect(page.locator('body')).toHaveText('Fixture');
            seedBuiltin(root, adapterBinary, nativeBinary);
            const restarted = await electron.evaluate(async () => {
              const win = globalThis as typeof globalThis & {
                studioFixture: { restart(): Promise<{ origin: string }> };
              };
              return win.studioFixture.restart();
            });
            await page.evaluate(
              (port) => {
                (window as RelayWindow).__backendPort = port;
              },
              Number(new URL(restarted.origin).port)
            );
            await checkRunningInput(page, fixture);
          } finally {
            await electron.close();
          }
        } else {
          const oldEnv = process.env;
          process.env = fixture.env;
          const manager = new BackendLifecycleManager(
            { version: '1.0.0', isPackaged: false, resourcesPath: root, userDataPath: root },
            () => hostBinary,
            true
          );
          try {
            await manager.start(root);
            await manager.stop();
            seedBuiltin(root, adapterBinary, nativeBinary);
            const backendPort = await manager.start(root);
            const reset = await fetchStudioBackend(`http://127.0.0.1:${backendPort}/api/webui/reset-password`, {
              method: 'POST',
            });
            assert(reset.ok, 'Operator setup failed');
            const credentials = (await reset.json()) as { data: { new_password: string } };
            const site = await startStaticServer({
              staticDir: fixture.site,
              backendPort,
              userDataPath: root,
              port: 0,
              allowRemote: false,
            });
            try {
              const browser = await chromium.launch();
              try {
                const page = await browser.newPage();
                await page.goto(site.localUrl);
                const login = await api(page, '/login', 'POST', {
                  username: 'admin',
                  password: credentials.data.new_password,
                });
                expect(login).toBeTruthy();
                await checkRunningInput(page, fixture);
              } finally {
                await browser.close();
              }
            } finally {
              await site.stop();
            }
          } finally {
            await manager.stop();
            process.env = oldEnv;
          }
        }
      } finally {
        await fixture.stop();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
