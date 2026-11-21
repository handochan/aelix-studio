import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, chromium, firefox, webkit } from '@playwright/test';
import { exerciseImageBatch, exerciseImageWorker, startUploadFixture } from './acceptance.mjs';

const [kind, target, fixtures] = process.argv.slice(2);
assert.ok(kind && target && fixtures, 'Usage: probe.mjs electron|chrome|edge|firefox|webkit TARGET FIXTURE_DIR');
const renderer = path.resolve('out/renderer');
const asset = (await readdir(path.join(renderer, 'assets'))).find((name) => /^running-input-images-.*\.js$/.test(name));
assert.ok(asset, 'Build the production renderer first');
const entry = './assets/' + asset;
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const cornerColors = [
  [235, 20, 20],
  [20, 235, 20],
  [20, 20, 235],
  [235, 235, 20],
];
const cornerOrder = [
  [0, 1, 2, 3],
  [1, 0, 3, 2],
  [3, 2, 1, 0],
  [2, 3, 0, 1],
  [0, 2, 1, 3],
  [2, 0, 3, 1],
  [3, 1, 2, 0],
  [1, 3, 0, 2],
];
const userData = await mkdtemp(path.join(tmpdir(), 'studio-image-probe-'));
let app;
let browser;
let fixtureUploadDirectory;
try {
  let page;
  if (kind === 'electron') {
    app = await _electron.launch({
      executablePath: target,
      env: {
        ...process.env,
        AIONUI_E2E_TEST: '1',
        AIONUI_E2E_USER_DATA_DIR: userData,
        AIONUI_DISABLE_DEVTOOLS: '1',
        AIONUI_CDP_PORT: '0',
      },
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.waitForURL('file:**/out/renderer/index.html**');
    assert.match(page.url(), /app\.asar\/out\/renderer\/index\.html/);
    await page.waitForFunction(() => Number(window.__backendPort) > 0);
  } else {
    const engine = kind === 'firefox' ? firefox : kind === 'webkit' ? webkit : chromium;
    const executablePath = process.env.IMAGE_PROBE_BROWSER_BIN;
    browser = await engine.launch(executablePath ? { executablePath } : kind === 'chrome' ? { channel: 'chrome' } : {});
    page = await browser.newPage();
    await page.goto(target);
    const user = process.env.IMAGE_PROBE_USER;
    const password = process.env.IMAGE_PROBE_PASSWORD;
    assert.ok(user && password, 'Set IMAGE_PROBE_USER and IMAGE_PROBE_PASSWORD for the isolated WebUI');
    await page.evaluate(
      async ({ username, secret }) => {
        const login = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password: secret, remember: false }),
        });
        if (!login.ok || !(await login.json()).success) throw new Error('Fixture login failed');
      },
      { username: user, secret: password }
    );
  }

  const fixtureContext = await page.evaluate(async () => {
    const base = window.__backendPort ? `http://127.0.0.1:${window.__backendPort}` : '';
    const csrf = document.cookie
      .split('; ')
      .find((field) => field.startsWith('aelix-studio-csrf-token='))
      ?.split('=')[1];
    const response = await fetch(base + '/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(csrf && { 'x-csrf-token': csrf }) },
      body: JSON.stringify({ type: 'acp', name: 'Studio image worker fixture', extra: { backend: 'aelix' } }),
    });
    const result = await response.json();
    if (!response.ok || !result.data?.id)
      throw new Error(`Fixture conversation failed: ${response.status} ${result.code}`);
    const id = result.data.id;
    const conversation = await fetch(base + '/api/conversations/' + encodeURIComponent(id)).then((r) => r.json());
    const projectId = conversation.data?.project_id;
    const workspace = conversation.data?.extra?.workspace;
    if (!projectId || !workspace) throw new Error('Fixture conversation has no project workspace');
    const project = await fetch(base + '/api/projects/' + encodeURIComponent(projectId)).then((r) => r.json());
    const projectEntry = project.data?.explorer?.workspace_pe_id;
    if (!projectEntry) throw new Error('Fixture project has no workspace entry');
    return { id, workspace, projectEntry };
  });
  const { id: conversationId, workspace, projectEntry } = fixtureContext;

  const secure = await page.evaluate(() => isSecureContext);
  const blink = /Chrome\//.test(await page.evaluate(() => navigator.userAgent));
  console.log(JSON.stringify({ browser: await page.evaluate(() => navigator.userAgent), secure }));
  const assets = await page.evaluate(async () => {
    if (location.protocol === 'file:') return { packagedFile: true };
    const html = await fetch(location.href).then((result) => result.text());
    return { staticHtml: html.includes('<div id="root">') };
  });
  assert.ok(assets.packagedFile || assets.staticHtml);
  const uploaded = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/fs/upload')) uploaded.push(request);
  });

  page.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname !== '/api/fs/stream') return;
    const code = request.failure()?.errorText;
    console.log(
      JSON.stringify({ stage: 'download', code: /^net::ERR_[A-Z_]+$/.test(code ?? '') ? code : 'request-failed' })
    );
  });

  async function measure(name, prepare) {
    if (
      process.env.IMAGE_PROBE_RSS !== '1' ||
      !['source-max.png', 'file-max.png', 'baseline-48mp.jpg'].includes(name)
    ) {
      return prepare();
    }
    const session = browser ? await browser.newBrowserCDPSession() : undefined;
    const pids = session
      ? (await session.send('SystemInfo.getProcessInfo')).processInfo
          .filter(({ type }) => type === 'renderer')
          .map(({ id }) => id)
      : await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => window.webContents.getOSProcessId())
        );
    await session?.detach();
    const rss = () => {
      try {
        return (
          execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' })
            .trim()
            .split(/\s+/)
            .reduce((sum, kib) => sum + Number(kib), 0) * 1024
        );
      } catch {
        return 0;
      }
    };
    const before = rss();
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, rss());
    }, 25);
    try {
      return await prepare();
    } finally {
      clearInterval(timer);
      console.log(
        JSON.stringify({
          name,
          sampledRendererRssBeforeBytes: before,
          sampledRendererRssPeakBytes: Math.max(peak, rss()),
        })
      );
    }
  }

  async function run(name, params = {}) {
    const input = await readFile(path.join(fixtures, name));
    const uploadsBefore = uploaded.length;
    let base64 = input.toString('base64');
    if (process.env.IMAGE_PROBE_RSS === '1') {
      await page.evaluate((encoded) => {
        globalThis.__imageWorkerProbeSource = new Blob([Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))]);
      }, base64);
      base64 = undefined;
    }
    const result = await measure(name, () =>
      page.evaluate(exerciseImageWorker, {
        entry,
        conversationId,
        name,
        forceJsHash: true,
        base64,
        ...params,
      })
    );
    assert.equal(result.windowSecure, secure);
    if (params.expected) {
      assert.equal(result.code, params.expected);
      assert.equal(uploaded.length, uploadsBefore);
      console.log(JSON.stringify({ name, code: result.code, originalSize: result.originalSize }));
      return result;
    }
    const output = Buffer.from(result.output, 'base64');
    assert.equal(result.secureContext, secure);
    assert.ok(result.original.digest.sha256 === digest(input), 'Original digest mismatch');
    assert.ok(result.sent.digest.sha256 === digest(output), 'Sent digest mismatch');
    if (!result.changed) assert.ok(input.equals(output), 'Pass-through bytes changed');
    if (result.preview === 'thumbnail') assert.ok(result.previewDigest === digest(output), 'Preview digest mismatch');
    assert.equal(uploaded.length - uploadsBefore, params.useRef && !result.changed ? 0 : 1);
    assert.ok(result.codecMs < 5000);
    if (!params.useRef) assert.ok(result.uploadProgress.some((progress) => progress.stage === 'upload-response'));
    assert.ok(result.hashProgress.some((progress) => progress.loaded === progress.total));
    const sizeAndTime = ({ width, height, bytes, digest: hash }) => ({
      width,
      height,
      bytes,
      hashMs: hash.elapsedMs,
      hashAlgorithm: hash.algorithm,
    });
    console.log(
      JSON.stringify({
        name,
        result: 'passed',
        original: sizeAndTime(result.original),
        sent: sizeAndTime(result.sent),
        changed: result.changed,
        preview: result.preview,
        plannedBytes: result.plannedBytes,
        codecMs: result.codecMs,
        totalMs: result.totalMs,
      })
    );
    return { ...result, output };
  }

  const oriented = (result, orientation, dimensions, tolerance = 12, noOriginalExif = false) => {
    assert.deepEqual([result.sent.width, result.sent.height], dimensions);
    result.pixels.forEach((pixel, index) => {
      const expected = cornerColors[cornerOrder[orientation - 1][index]];
      assert.ok(
        expected.every((value, channel) => Math.abs(value - pixel[channel]) < tolerance),
        'Corner color mismatch'
      );
    });
    assert.equal(result.output.includes(Buffer.from('Exif\0\0')), orientation === 1 && !noOriginalExif);
  };

  for (let index = 1; index <= 8; index++) {
    oriented(await run(`exif-${index}.jpg`), index, index >= 5 ? [64, 96] : [96, 64]);
  }
  oriented(await run('cmyk.jpg'), 1, [48, 32], 32, true);
  const cmyk = await run('cmyk-rotated.jpg');
  oriented(cmyk, 6, [32, 48], 32);
  assert.ok(cmyk.plannedBytes >= 20 * 1024 * 1024 + 48 * 32 * 12 + cmyk.original.bytes);
  const alpha = await run('alpha.png', { edgeLimit: 2048 });
  assert.equal(alpha.pixels[0][3], 0);
  assert.equal(alpha.pixels[1][3], 128);
  assert.ok(alpha.pixels[1].slice(0, 3).every((value, index) => Math.abs(value - [133, 99, 88][index]) <= 6));
  const baseline = await run(
    'baseline-48mp.jpg',
    !secure ? { expected: 'secure-context-required' } : !blink ? { expected: 'codec-unavailable' } : {}
  );
  if (secure && blink) oriented(baseline, 6, [1536, 2048]);
  await run('progressive-48mp.jpg', { expected: secure ? 'decode-limit' : 'secure-context-required' });
  await run('oversized-8001.png', { expected: 'decode-limit' });
  await run('long.png', { expected: 'decode-limit' });
  await run('truncated.png', { expected: 'invalid-image' });
  await run('truncated.jpg', { expected: 'invalid-image' });
  await run('animated.png', { expected: 'unsupported-format' });
  await run('corrupt-idat.png', { expected: 'invalid-image' });
  await run('adam7.png');
  for (const fixture of [
    'screenshot-macos.png',
    'screenshot-windows.png',
    'screenshot-windows-padded.png',
    'screenshot-ancillary.png',
  ]) {
    const screenshot = await run(fixture);
    assert.ok(!screenshot.changed, 'Screenshot fixture should be passed through');
  }
  let noRasterLoads = 0;
  const noRaster = async (route) => {
    noRasterLoads++;
    const response = await route.fetch();
    await route.fulfill({
      response,
      body:
        "globalThis.createImageBitmap = () => { throw new Error('unexpected-raster'); };\n" + (await response.text()),
    });
  };
  const workerPattern = '**/image.worker-*.js';
  if (kind === 'chrome') await page.route(workerPattern, noRaster);
  const huge = await run('passthrough-8000.png');
  const paddedHuge = await run('passthrough-8000-padded.png');
  assert.ok(!paddedHuge.changed && paddedHuge.preview === 'icon');
  assert.deepEqual([paddedHuge.sent.width, paddedHuge.sent.height], [8000, 8000]);
  if (kind === 'chrome') {
    await page.unroute(workerPattern, noRaster);
    assert.ok(noRasterLoads > 0, 'Raster prohibition was not installed in the worker');
  }
  const derivativeParent = path.dirname(huge.ref.path);
  assert.ok(
    path.basename(derivativeParent) === conversationId && path.basename(path.dirname(derivativeParent)) === 'aionui',
    'Upload escaped the per-conversation temp scope'
  );
  fixtureUploadDirectory = derivativeParent;
  assert.equal(huge.preview, 'icon');
  assert.deepEqual([huge.sent.width, huge.sent.height], [8000, 8000]);

  const worst = await run('source-max.png');
  assert.equal(worst.original.bytes, 16_777_216);
  const maxFile = await run('file-max.png');
  assert.equal(maxFile.sent.bytes, 3_750_000);
  await run('file-max.png', { useRef: maxFile.ref });
  const localSource = path.join(workspace, 'studio-image-local');
  const projectSource = path.join(workspace, 'studio-image-project');
  await copyFile(path.join(fixtures, 'exif-1.jpg'), localSource);
  await copyFile(path.join(fixtures, 'adam7.png'), projectSource);
  const beforeBatch = uploaded.length;
  const batch = await page.evaluate(exerciseImageBatch, {
    entry,
    conversationId,
    references: [
      huge.ref,
      { kind: 'local', path: localSource },
      { kind: 'project', pe_id: projectEntry, relative_path: 'studio-image-project' },
    ],
    large: (await readFile(path.join(fixtures, 'source-max.png'))).toString('base64'),
  });
  assert.ok(batch.codecMs < 15_000 && batch.images.every((image) => image.codecMs < 5_000));
  assert.ok(batch.estimatedLineBytes <= 8 * 1024 * 1024);
  assert.equal(batch.images[0].changed, true);
  assert.ok(
    batch.images.slice(1).every((image) => image.preservedRef && !image.changed),
    'Original reference changed'
  );
  assert.deepEqual(
    batch.images.map((image) => image.kind),
    ['upload', 'upload', 'local', 'project']
  );
  assert.equal(uploaded.length - beforeBatch, batch.images.filter((image) => image.changed).length);
  console.log(JSON.stringify({ name: 'four-image-batch', ...batch }));
  await run('source-max.png', { expected: 'cancelled', cancelDuringHash: true });
  if (process.env.IMAGE_PROBE_THROTTLE === '1') {
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 50,
      downloadThroughput: 200 * 1024,
      uploadThroughput: 200 * 1024,
    });
    try {
      const throttled = await run('file-max.png', { useRef: maxFile.ref, edgeLimit: 128 });
      assert.ok(throttled.totalMs > 15_000 && throttled.codecMs < 5000 && throttled.changed);
    } finally {
      await session.detach();
    }
  }
  if (secure) {
    const webCrypto = await run('source-max.png', { forceJsHash: false });
    assert.equal(webCrypto.original.digest.algorithm, 'web-crypto');
    assert.ok(webCrypto.sent.digest.sha256 === worst.sent.digest.sha256, 'Hash implementations disagree');
  }
  if (kind === 'chrome') {
    const session = await page.context().newCDPSession(page);
    const base64 = (await readFile(path.join(fixtures, 'adam7.png'))).toString('base64');
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/fs/upload', requestStage: 'Response' }] });
    try {
      for (const fault of ['cancel', 'response-lost']) {
        const attempts = uploaded.length;
        let pauseDeadline;
        const paused = new Promise((resolve, reject) => {
          pauseDeadline = setTimeout(() => reject(new Error('Fixture upload response was not intercepted')), 15_000);
          session.once('Fetch.requestPaused', resolve);
        });
        await page.evaluate(startUploadFixture, { entry, conversationId, base64 });
        const { requestId, responseStatusCode, responseHeaders } = await paused.finally(() =>
          clearTimeout(pauseDeadline)
        );
        const response = await session.send('Fetch.getResponseBody', { requestId });
        const body = Buffer.from(response.body, response.base64Encoded ? 'base64' : 'utf8');
        const storedPath = JSON.parse(body.toString()).data;
        assert.ok(
          responseStatusCode === 200 && path.dirname(storedPath) === fixtureUploadDirectory,
          'Invalid stored upload'
        );
        assert.ok(/^[a-f0-9]{32}\.png$/.test(path.basename(storedPath)), 'Upload name is not opaque');

        if (fault === 'cancel') {
          assert.equal(await page.evaluate(() => globalThis.__imageUploadFixture.cancelQueuedBlobs()), 12);
          await session.send('HeapProfiler.collectGarbage');
          assert.equal(
            await page.evaluate(() => globalThis.__imageCancelledBlobs.filter(({ weak }) => weak.deref()).length),
            0
          );
          await page.evaluate(() => globalThis.__imageUploadFixture.job.dispose());
          await session
            .send('Fetch.fulfillRequest', {
              requestId,
              responseCode: responseStatusCode,
              responseHeaders,
              body: body.toString('base64'),
            })
            .catch(() => undefined); // Chromium may have already dropped the aborted request.
        } else {
          await session.send('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        }

        const settled = await page.evaluate(async () => {
          const { job, first, outcome } = globalThis.__imageUploadFixture;
          const settled = await outcome;
          const again = job.prepare();
          void again.catch(() => {});
          return { outcome: settled, repeat: again === first };
        });
        assert.equal(settled.outcome, fault === 'cancel' ? 'cancelled' : 'upload-outcome-unknown');
        assert.equal(settled.repeat, fault === 'response-lost');
        assert.equal(uploaded.length - attempts, 1);
        const retained = await stat(storedPath).catch(() => {
          throw new Error('Stored fixture upload missing');
        });
        assert.equal(retained.size, Buffer.from(base64, 'base64').length);
        console.log(
          JSON.stringify({
            name: fault,
            result: 'passed',
            retainedUploads: 1,
            queuedBlobReferences: fault === 'cancel' ? 0 : undefined,
          })
        );
      }
    } finally {
      await session.detach();
    }
  }
} finally {
  await browser?.close();
  await app?.close();
  if (fixtureUploadDirectory) await rm(fixtureUploadDirectory, { recursive: true, force: true });
  await rm(userData, { recursive: true, force: true });
}
