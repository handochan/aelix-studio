import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron, expect } from '@playwright/test';
import httpBridge from '../../../e2e/helpers/httpBridge.ts';
import { closeElectron } from '../../../../scripts/studio-preview/host-release/verification.mjs';
import { attach, clickTimed, observeRenderer, takeAck } from './browser.mjs';
import { digest, holdMessage, model, providerId, startProvider } from './provider.mjs';
import { startWebUI, webuiApi } from './webui.mjs';

const scenarios = [
  { name: 'idle-png', image: 'idle.png', write: 'prompt', notice: 'none' },
  { name: 'steer-png', image: 'steer.png', write: 'steer', notice: 'queued' },
  { name: 'follow-up-jpeg', image: 'follow-up.jpg', write: 'follow_up', notice: 'queued' },
  { name: 'caption', image: 'caption.png', write: 'steer', notice: 'caption' },
  { name: 'downscale', image: 'large.jpg', write: 'steer', notice: 'downscaled' },
  { name: 'five-paths', image: null, write: 'steer', notice: 'blocked-path-only' },
  { name: 'stop-pending', image: 'stop.png', write: 'steer', notice: 'queued-after-stop' },
];
const surface = process.env.IMAGE_SURFACE ?? 'electron';
assert.ok(surface === 'electron' || surface === 'webui');
const { httpGet, httpPost } = surface === 'electron' ? httpBridge : webuiApi;
const output = path.resolve(
  surface === 'electron' ? '.local/image-acceptance.json' : '.local/image-acceptance-webui.json'
);
const inputs = path.resolve(process.env.IMAGE_INPUTS ?? '.local/image-acceptance-inputs');
const baseline = JSON.parse(fs.readFileSync('scripts/studio-preview/baseline.json'));
const result = {
  schema: 'studio.running-image-acceptance/1',
  target: process.platform + '-' + process.arch,
  surface,
  status: 'failed',
  stage: 'setup',
  failure: null,
  host: baseline.aioncore.tag,
  acp: baseline.acp.commit,
  native: baseline.native.sourceTag.commit,
  sampleIntervalMs: 125,
  scenarios: [],
};
const state = () => ({ studio: 0, host: 0, acp: 0, native: 0 });
const save = () => {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
};
function classifyFailure(error) {
  const message = String(error?.message ?? '');
  if (/SUID sandbox|No usable sandbox|namespace sandbox/i.test(message)) return 'chromium-sandbox';
  if (/cannot open shared object file|Library not loaded/i.test(message)) return 'missing-library';
  if (/Unable to open X display|Missing X server/i.test(message)) return 'display-unavailable';
  if (/Process failed to launch|failed to launch/i.test(message)) return 'launch-failed';
  if (error?.code === 'ENOENT') return 'file-not-found';
  if (/intercepts pointer events/i.test(message)) return 'click-obscured';
  if (error?.name === 'TimeoutError') return 'timeout';
  return 'assertion-or-runtime';
}
process.on('uncaughtExceptionMonitor', (error) => {
  result.failure = classifyFailure(error);
  save();
});
const config = (dir, name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data), { mode: 0o600 });
const options = { timeout: 25000 };
const driver = process.env.IMAGE_PYTHON ?? 'python3';
const runtimeFixture = path.join(import.meta.dirname, 'acceptanceRuntime.py');
const stoppedNotice = /Not confirmed whether they were handled after Stop/;
const empty = () => ({ bytes: null, sha256: null });

let app;
let webui;
let root;
let provider;
let sampler;
let sampleTask;
let frameFile;
let peak;
let offset = 0;
let stage;
const writes = () => {
  const saved = fs.readFileSync(frameFile, 'utf8');
  return saved
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

function sampleRss(pid, browserPid = 0) {
  sampler = spawn(driver, ['-I', '-B', path.join(import.meta.dirname, 'sampleRss.py')], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  sampler.on('error', () => {});
  sampler.stdin.on('error', () => {});
  const lines = createInterface({ input: sampler.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  return (async () => {
    while (sampler.exitCode === null && !sampler.stdin.destroyed) {
      const row = writes().slice(offset).at(-1);
      sampler.stdin.write([pid, row?.acpPid ?? 0, row?.nativePid ?? 0, browserPid].join(' ') + '\n');
      const line = await iterator.next();
      if (line.done) break;
      const sample = JSON.parse(line.value);
      if (peak) for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], sample[key] ?? 0);
      await delay(result.sampleIntervalMs);
    }
  })();
}

function executable() {
  if (process.env.IMAGE_EXECUTABLE) return path.resolve(process.env.IMAGE_EXECUTABLE);
  const out = path.resolve('.local/provider-installer/artifacts');
  const name = process.platform === 'win32' ? 'Aelix Studio.exe' : 'aelix-studio';
  const choices = fs
    .readdirSync(out, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
    .map((entry) => path.join(out, entry.name, name))
    .filter((file) => fs.existsSync(file));
  assert.equal(choices.length, 1);
  return choices[0];
}

function isolatedEnv(root, agent) {
  const keys = ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'DISPLAY', 'XAUTHORITY', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key.toUpperCase())));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'temp');
  for (const key of [home, temp, path.join(home, 'appdata'), path.join(home, 'localappdata')])
    fs.mkdirSync(key, { recursive: true });
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'appdata'),
    LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    AELIX_CODING_AGENT_DIR: agent,
    AIONUI_E2E_TEST: '1',
    AIONUI_E2E_USER_DATA_DIR: path.join(root, 'studio'),
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_CDP_PORT: '0',
    AIONUI_EXTENSIONS_PATH: path.join(root, 'extensions'),
    AIONUI_EXTENSION_STATES_FILE: path.join(root, 'extension-states.json'),
  };
}

async function createConversation(page, name, workspace) {
  const conversation = await httpPost(page, '/api/conversations', {
    type: 'acp',
    name,
    extra: { agent_id: 'fixture-images', backend: 'aelix', workspace, custom_workspace: true },
  });
  assert.ok(conversation?.id);
  await page.evaluate((id) => {
    location.hash = '/conversation/' + id;
  }, conversation.id);
  await page.waitForFunction((id) => location.hash.includes(id), conversation.id);
  await expect(page.getByTestId('sendbox-input')).toBeVisible(options);
  return '/api/conversations/' + conversation.id;
}

async function waitForObservation(read) {
  await expect.poll(read, options).toBeTruthy();
}

async function runScenario(page, scenario, row) {
  const check = (next) => {
    stage = next;
  };
  const pixel = page.locator('[data-testid="running-input-notice"][data-images="true"]');
  const frameStart = writes().length;
  offset = frameStart;
  const providerStart = provider.requests.length;
  peak = state();
  const frames = () => writes().slice(frameStart);
  const requests = () => provider.requests.slice(providerStart);
  check('conversation');
  const workspace = path.join(root, scenario.name);
  fs.mkdirSync(workspace);
  const scope = await createConversation(page, scenario.name, workspace);
  const input = page.getByTestId('sendbox-input');
  const send = page.getByTestId('sendbox-send-btn');
  const stop = page.locator('.sendbox-stop-button');
  const busy = scenario.write !== 'prompt';
  const stopCase = scenario.name === 'stop-pending';
  const pathCase = scenario.name === 'five-paths';
  await page.evaluate(() => {
    const probe = window.__runningImageFixture;
    probe.uploads.length = 0;
    probe.uploadStatuses.length = 0;
    probe.acknowledgments.length = 0;
  });
  check('held-turn');
  if (busy) {
    await input.fill(holdMessage);
    await send.click();
    check('hold-provider');
    await waitForObservation(() => requests().some(({ held }) => held));
    // The boot prompt can be accepted by Host before ACP marks its native turn
    // active. A fresh renderer queries the already-running turn without a send.
    await page.reload({ waitUntil: 'domcontentloaded' });
    check('native-active');
    await page.waitForFunction(
      () => window.__runningImageFixture.acknowledgments.some(({ kind, active }) => kind === 'turn-state' && active),
      undefined,
      options
    );
    check('mode-visible');
    const mode = page.getByTestId('running-input-mode');
    await expect(mode).toBeVisible(options);
    check('mode-select');
    const value = scenario.write === 'follow_up' ? 'follow-up' : 'steer';
    const radio = mode.locator('input[type="radio"][value="' + value + '"]');
    await mode
      .locator('label')
      .filter({ has: page.locator('input[type="radio"][value="' + value + '"]') })
      .click();
    await expect(radio).toBeChecked(options);
  }
  check('attach');
  const files = (pathCase ? ['idle.png', 'steer.png', 'caption.png', 'stop.png', 'extra.png'] : [scenario.image]).map(
    (file) => path.join(inputs, file)
  );
  const source = scenario.image ? digest(fs.readFileSync(files[0])) : empty();
  row.source = source;
  await attach(page, files, files.length, check);
  for (const file of files) {
    await expect(page.locator('.sendbox-panel').getByAltText(path.parse(file).name)).toBeVisible(options);
  }
  check('attachment-blobs');
  const initialUploads = await page.evaluate(() => [...window.__runningImageFixture.uploads]);
  assert.deepEqual(
    initialUploads.map(({ sha256 }) => sha256).sort(),
    files.map((file) => digest(fs.readFileSync(file)).sha256).sort()
  );
  if (scenario.notice !== 'caption') await input.fill('Inspect the acceptance attachment.');
  if (stopCase)
    await page.evaluate(() => {
      window.__runningImageFixture.holdImageAck = true;
    });
  // Let the attachment and text render settle before taking the submission snapshot.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check('send');
  const start = await clickTimed(page, send);
  check('send-ack');
  let ack;
  if (pathCase) {
    const blocked = page.getByTestId('running-image-submission');
    await expect(blocked).toHaveAttribute('data-status', 'blocked', options);
    await expect(blocked).toContainText(/4.*images/, options);
    assert.equal(frames().length, 1);
    assert.equal(requests().length, 1);
    const pathStart = await clickTimed(page, blocked.getByRole('button', { name: 'Send paths only' }));
    ack = await takeAck(page, 'steer', pathStart);
    await expect(
      page.locator('[data-testid="running-input-notice"][data-kind="queued"]:not([data-images])')
    ).toBeVisible(options);
    await expect(blocked).toHaveCount(0, options);
  } else {
    const kind = busy ? scenario.write.replace('_', '-') + '-images' : 'prompt';
    ack = await takeAck(page, kind, start);
  }
  assert.equal(ack.success, true);
  assert.equal(ack.queued, busy);
  row.ackMs = ack.ms;
  row.captionAdded = ack.captionAdded;
  assert.equal(ack.captionAdded, scenario.notice === 'caption');

  check('notice');
  if (stopCase) {
    check('pending-notice');
    await expect(pixel).toHaveAttribute('data-kind', 'pending', options);
    // The composer shows Send in its action slot while a draft is present.
    // Clear the draft through the UI after dispatch to expose the real Stop.
    await input.fill('');
    const chip = page
      .locator('.sendbox-panel .relative.inline-block')
      .filter({ has: page.getByAltText(path.parse(scenario.image).name) });
    await chip.locator(':scope > div.absolute').click();
    await expect(pixel).toHaveAttribute('data-kind', 'pending', options);
    check('stop-ack');
    const stopStart = await clickTimed(page, stop);
    const stopped = await takeAck(page, 'abort', stopStart);
    assert.equal(stopped.success, true);
    row.stopAckMs = stopped.ms;
    await expect(stop).toBeHidden(options);
    await page.evaluate(() => {
      window.__runningImageFixture.holdImageAck = false;
      window.__runningImageFixture.releaseImageAck();
    });
    check('stop-notice');
    await expect(pixel).toContainText(stoppedNotice, options);
    row.noticeAckMs = Math.round(await page.evaluate((started) => performance.now() - started, start));
  }
  if (busy && !pathCase) {
    await expect(pixel).toHaveAttribute('data-kind', 'queued', options);
    await expect(pixel.getByTestId('running-image-tile')).toHaveCount(1, options);
    await expect(pixel.getByTestId('running-image-caption')).toHaveCount(
      scenario.notice === 'caption' ? 1 : 0,
      options
    );
  } else {
    await expect(pixel).toHaveCount(0, options);
  }

  check('native-write');
  const expectedCommands = busy ? ['prompt', scenario.write, ...(stopCase ? ['abort'] : [])] : ['prompt'];
  await waitForObservation(() => frames().length >= expectedCommands.length);
  const native = frames().find(({ method }) => method === scenario.write);
  assert.ok(native);
  const studioUploads = await page.evaluate(() => [...window.__runningImageFixture.uploads]);
  const studio = scenario.notice === 'downscaled' ? studioUploads.at(-1) : initialUploads[0];
  if (!pathCase) {
    row.studio = studio;
    row.native = native.images[0] ?? empty();
    assert.deepEqual(native.images, [studio]);
    if (scenario.notice === 'downscaled') {
      assert.equal(studioUploads.length, 2);
      assert.notEqual(studio.sha256, source.sha256);
      const tile = pixel.getByTestId('running-image-tile');
      await expect(tile).toContainText('6000×4000', options);
      await expect(tile).toContainText('2048×1365', options);
      const detail = await tile.getAttribute('title');
      assert.ok(
        detail.includes(source.bytes.toLocaleString('en-US')) && detail.includes(studio.bytes.toLocaleString('en-US'))
      );
      row.dimensions = { original: [6000, 4000], sent: [2048, 1365] };
    }
  } else {
    assert.equal(native.pathCount, 5);
    assert.equal(native.images.length, 0);
    row.pathCount = 5;
  }
  assert.equal(native.captionAdded, scenario.notice === 'caption');
  row.nativeImageWrites = frames().filter(({ images }) => images.length > 0).length;
  row.nativeWrites = frames().filter(({ method }) => method === scenario.write).length;
  row.stopWrites = frames().filter(({ method }) => method === 'abort').length;
  row.notice = scenario.notice;

  check('provider');
  provider.release();
  if (!stopCase) {
    await waitForObservation(() =>
      requests().some((request) =>
        pathCase ? request.pathCount === 5 : request.images.some(({ sha256 }) => sha256 === studio.sha256)
      )
    );
  }
  await waitForObservation(async () => {
    const { runtime } = await httpGet(page, scope);
    return runtime && !runtime.is_processing && runtime.turn_id == null;
  });
  assert.deepEqual(
    frames().map(({ method }) => method),
    expectedCommands
  );
  assert.equal(provider.failed, false);
  const images = requests().flatMap((request) => request.images);
  assert.deepEqual(images, pathCase || stopCase ? [] : [studio]);
  if (scenario.notice === 'caption') assert.ok(requests().some(({ captionAdded }) => captionAdded));
  if (scenario.notice === 'caption') {
    const bubbles = page.getByTestId('message-text-right');
    await expect(bubbles.filter({ hasText: /The user attached one or more images/ })).toHaveCount(0, options);
  }
  row.provider = images[0] ?? empty();
  row.providerImageOccurrences = images.length;
  check('rss');
  await waitForObservation(() => Object.values(peak).every((value) => value > 0));
  row.peakRssBytes = { ...peak };
  row.status = 'passed';
}

save();
try {
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'studio-image-'))
  );
  const agent = path.join(root, 'agent');
  frameFile = path.join(root, 'native-writes.jsonl');
  fs.mkdirSync(agent);
  fs.writeFileSync(frameFile, '');
  const env = isolatedEnv(root, agent);
  config(agent, 'models.json', {
    providers: {
      [providerId]: {
        baseUrl: 'https://chatgpt.com/backend-api',
        api: 'openai-codex-responses',
        apiKey: 'synthetic-fixture',
        models: [
          { id: model, name: 'Fixture Vision', input: ['text', 'image'], contextWindow: 1050000, maxTokens: 128000 },
        ],
      },
    },
  });
  config(agent, 'settings.json', {
    defaultProvider: providerId,
    defaultModel: model,
    defaultThinkingLevel: 'off',
    checkForUpdates: false,
    compaction: { enabled: false },
    retry: { enabled: false },
  });

  result.stage = 'application';
  save();
  provider = await startProvider();
  const fixtureEnv = {
    STUDIO_FIXTURE_WRITES: frameFile,
    STUDIO_FIXTURE_PROVIDER: provider.url,
  };
  Object.assign(env, fixtureEnv);
  const launch = async () => {
    const candidate = await electron.launch({ executablePath: executable(), cwd: root, args: [], env, timeout: 60000 });
    candidate.process().stdout?.resume();
    candidate.process().stderr?.resume();
    return candidate;
  };
  app = await launch();
  const bundle = await app.evaluate(() => process.resourcesPath).then((dir) => path.join(dir, 'studio-preview'));
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.target, result.target);
  assert.equal(manifest.nativePatches.length, 0);
  assert.equal(manifest.acp.commit, result.acp);
  assert.equal(manifest.native.sourceTag.commit, result.native);
  assert.equal(manifest.baselineSha256, digest(fs.readFileSync('scripts/studio-preview/baseline.json')).sha256);
  assert.equal(path.basename(await app.evaluate(({ app }) => app.getAppPath())), 'app.asar');
  const python = path.join(bundle, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
  const initial = await app.firstWindow();
  await initial.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  let password;
  if (surface === 'webui') {
    result.stage = 'webui-credential';
    save();
    const reset = await httpBridge.httpPost(initial, '/api/webui/reset-password');
    password = reset?.new_password;
    assert.ok(typeof password === 'string' && password.length > 0);
  }
  await closeElectron(app);
  app = undefined;

  // Like the #113 integration, seed only the sandbox catalog. The released
  // Host negotiates H1 exclusively with an unoverridden builtin Aelix entry.
  result.stage = 'seed-builtin';
  save();
  const database = path.join(env.AIONUI_E2E_USER_DATA_DIR, 'aionui', 'aionui-backend.db');
  assert.ok(fs.existsSync(database));
  const seeded = spawnSync(driver, ['-I', '-B', runtimeFixture, 'seed', database], {
    input: JSON.stringify([
      python,
      [
        '-I',
        '-S',
        '-B',
        '-Xutf8',
        runtimeFixture,
        bundle,
        'acp',
        '--profile',
        'coding',
        '--provider=' + providerId,
        '--model=' + model,
        '--permission-mode',
        'yolo',
        '--state-dir',
        path.join(root, 'acp'),
      ],
      Object.entries({
        AELIX_CODING_AGENT_DIR: agent,
        AELIX_ACP_STUDIO_MANAGED: '1',
        STUDIO_FIXTURE_WRITES: frameFile,
        STUDIO_FIXTURE_PROVIDER: provider.url,
      }).map(([name, value]) => ({ name, value })),
    ]),
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(seeded.status, 0);

  result.stage = 'application-restart';
  save();
  const setupPage = async (page) => {
    await page.exposeFunction('__fixtureHash', (encoded) => digest(Buffer.from(encoded, 'base64')));
    await page.addInitScript(observeRenderer);
  };
  let page;
  if (surface === 'webui') {
    result.stage = 'webui-login';
    save();
    webui = await startWebUI({
      executable: executable(),
      cwd: root,
      env,
      password,
      setupPage,
      stage: (name) => {
        result.stage = name;
        save();
      },
    });
    ({ page } = webui);
    sampleTask = sampleRss(webui.pid, webui.browserPid);
  } else {
    app = await launch();
    // Playwright starts Electron through cmd.exe on Windows. Measure the main
    // process and its children using the PID inside Electron.
    sampleTask = sampleRss(await app.evaluate(() => process.pid));
    page = await app.firstWindow();
    await setupPage(page);
    await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__runningImageFixture && window.__backendPort > 0);
  }
  void sampleTask.catch(() => {
    sampler?.kill();
  });
  result.stage = 'scenarios';
  save();
  for (const scenario of scenarios) {
    const row = {
      scenario: scenario.name,
      surface,
      status: 'failed',
      stage: 'start',
      notice: null,
      captionAdded: null,
      nativeWrites: null,
      nativeImageWrites: null,
      stopWrites: null,
      providerImageOccurrences: null,
      pathCount: null,
      ackMs: null,
      stopAckMs: null,
      noticeAckMs: null,
      peakRssBytes: null,
      dimensions: null,
      uploadStatuses: [],
      observedNativeMethods: [],
      source: empty(),
      native: empty(),
      studio: empty(),
      provider: empty(),
    };
    result.scenarios.push(row);
    try {
      await runScenario(page, scenario, row);
      row.stage = 'complete';
    } catch (error) {
      row.stage = stage;
      row.failure = classifyFailure(error);
      row.renderer = await page
        .evaluate(() => {
          const submission = document.querySelector('[data-testid="running-image-submission"]');
          const knownReasons = {
            'not supported': 'unsupported',
            'cannot be read': 'unreadable',
            model: 'model',
            verified: 'verification',
            'could not': 'unavailable',
            secure: 'secure-context',
            changed: 'changed',
            'not sent': 'blocked',
          };
          const notice = submission?.textContent?.toLowerCase() ?? '';
          return {
            status: submission?.getAttribute('data-status') ?? null,
            reason: Object.keys(knownReasons)
              .filter((key) => notice.includes(key))
              .map((key) => knownReasons[key]),
            responses: window.__runningImageFixture.acknowledgments
              .map(({ kind, status, active }) => ({ kind, status, active }))
              .slice(-16),
          };
        })
        .catch(() => null);
      row.providerFailed = provider.failed;
      row.heldRequests = provider.requests.filter(({ held }) => held).length;
      row.providerRequests = provider.requests.length;
      row.uploadStatuses = await page.evaluate(() => window.__runningImageFixture.uploadStatuses).catch(() => []);
      row.observedNativeMethods = writes()
        .slice(offset)
        .map(({ method }) => method);
      throw new Error('scenario failed');
    } finally {
      save();
    }
  }
  result.stage = 'complete';
  result.status = 'passed';
} catch (error) {
  result.failure = classifyFailure(error);
  process.exitCode = 1;
} finally {
  if (sampler?.exitCode === null) {
    const exited = once(sampler, 'exit').catch(() => {});
    sampler.stdin.end();
    await exited;
  }
  await sampleTask?.catch(() => {});
  await provider?.close();
  try {
    if (webui) await webui.close();
    if (app) await closeElectron(app);
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    result.status = 'failed';
    result.stage = 'cleanup';
    result.failure = 'cleanup-failed';
    process.exitCode = 1;
  }
  save();
}
