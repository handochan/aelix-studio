import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, chromium, firefox, webkit } from '@playwright/test';
import { exerciseImageBatch, exerciseImageWorker } from './acceptance.mjs';

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

  const conversationId = await page.evaluate(async () => {
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
    return result.data.id;
  });

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
    assert.equal(result.original.digest.sha256, digest(input));
    assert.equal(result.sent.digest.sha256, digest(output));
    if (!result.changed) assert.deepEqual(input, output);
    if (result.preview === 'thumbnail') assert.equal(result.previewDigest, digest(output));
    assert.equal(uploaded.length - uploadsBefore, params.useRef && !result.changed ? 0 : 1);
    assert.ok(result.codecMs < 5000);
    if (!params.useRef) assert.ok(result.uploadProgress.some((progress) => progress.stage === 'upload-response'));
    const { output: _output, ref: _ref, uploadProgress: _upload, hashProgress, ...summary } = result;
    assert.ok(hashProgress.some((progress) => progress.loaded === progress.total));
    console.log(JSON.stringify({ name, ...summary }));
    return { ...result, output };
  }

  const oriented = (result, orientation, dimensions) => {
    assert.deepEqual([result.sent.width, result.sent.height], dimensions);
    result.pixels.forEach((pixel, index) => {
      const expected = cornerColors[cornerOrder[orientation - 1][index]];
      assert.ok(
        expected.every((value, channel) => Math.abs(value - pixel[channel]) < 12),
        JSON.stringify(pixel)
      );
    });
    assert.equal(result.output.includes(Buffer.from('Exif\0\0')), orientation === 1);
  };

  for (let index = 1; index <= 8; index++) {
    oriented(await run(`exif-${index}.jpg`), index, index >= 5 ? [64, 96] : [96, 64]);
  }
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
  const huge = await run('passthrough-8000.png');
  assert.equal(huge.preview, 'icon');
  assert.deepEqual([huge.sent.width, huge.sent.height], [8000, 8000]);

  const worst = await run('source-max.png');
  assert.equal(worst.original.bytes, 16_777_216);
  const maxFile = await run('file-max.png');
  assert.equal(maxFile.sent.bytes, 3_750_000);
  await run('file-max.png', { useRef: maxFile.ref });
  const beforeBatch = uploaded.length;
  const batch = await page.evaluate(exerciseImageBatch, {
    entry,
    conversationId,
    references: [huge.ref, maxFile.ref, huge.ref],
    large: (await readFile(path.join(fixtures, 'source-max.png'))).toString('base64'),
  });
  assert.ok(batch.codecMs < 15_000 && batch.images.every((image) => image.codecMs < 5_000));
  assert.ok(batch.estimatedLineBytes <= 8 * 1024 * 1024);
  assert.equal(batch.images[0].changed, true);
  assert.equal(batch.images[1].changed, false);
  assert.equal(batch.images[3].changed, false);
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
    assert.equal(webCrypto.sent.digest.sha256, worst.sent.digest.sha256);
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(userData, { recursive: true, force: true });
}
