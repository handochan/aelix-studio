import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron } from 'playwright';
import type { PreviewPrivacyHarness } from './renderer';

declare global {
  interface Window {
    previewPrivacy: PreviewPrivacyHarness;
  }
}

const PATH_MARKER = 'private folder/경로+report.pdf';
const IMAGE_MARKER = 'cHJpdmF0ZS1pbWFnZS1ieXRlcw==';
const INVALID_IMAGE = `data:image/png;base64,${IMAGE_MARKER}!`;
const CHARSET_MARKER = 'cHJpdmF0ZS1jaGFyc2V0';
const INVALID_CHARSET = `data:image/png;charset=bad value;base64,${CHARSET_MARKER}`;
const SVG = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')}`;
const REQUEST_FILE = { kind: 'project', pe_id: 'fixture-project', relative_path: PATH_MARKER } as const;

test('preview failures keep file paths and image bytes out of Chromium logs', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'studio-preview-privacy-'));
  const home = join(sandbox, 'home');
  const userData = join(sandbox, 'user-data');
  const data = join(sandbox, 'data');
  const logs = join(sandbox, 'logs');
  let lastDownload: { url?: string; method?: string; accept?: string; csrf: unknown; body: unknown } | undefined;
  let downloadResponse: 'denied' | 'stream' | 'legacy' = 'denied';
  const bundle = await build({
    entryPoints: ['tests/e2e/preview-privacy/renderer.tsx'],
    bundle: true,
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
  });
  const server = createServer(async (request, response) => {
    if (request.url === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<div id="preview"></div><script src="/renderer.js"></script>');
      return;
    }
    if (request.url === '/renderer.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(bundle.outputFiles[0].text);
      return;
    }
    if (request.url === '/api/fs/content' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.encoding === 'dataurl') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, data: INVALID_IMAGE }));
        return;
      }
      lastDownload = {
        url: request.url,
        method: request.method,
        accept: request.headers.accept,
        csrf: request.headers['x-csrf-token'],
        body,
      };
      if (downloadResponse === 'stream') {
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(Buffer.from([0, 255, 42]));
        return;
      }
      if (downloadResponse === 'legacy') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ success: true, data: 'AP8q' }));
        return;
      }
    }
    response.writeHead(403).end();
  });

  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    await Promise.all([home, userData, data, logs].map((dir) => mkdir(dir)));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server failed to bind');
    const main = join(sandbox, 'main.cjs');
    await writeFile(
      main,
      `
        const { app, BrowserWindow } = require('electron');
        app.setPath('home', ${JSON.stringify(home)});
        app.setPath('userData', ${JSON.stringify(userData)});
        app.setAppLogsPath(${JSON.stringify(logs)});
        app.whenReady().then(() => {
          const window = new BrowserWindow({ show: false });
          window.loadURL('http://127.0.0.1:${address.port}');
        });
      `
    );
    app = await _electron.launch({
      args: [main],
      env: { ...process.env, HOME: home, USERPROFILE: home, DATA_DIR: data, XDG_DATA_HOME: data },
    });
    const page = await app.firstWindow();
    await app
      .context()
      .addCookies([
        { name: 'aelix-studio-csrf-token', value: 'fixture-csrf', url: `http://127.0.0.1:${address.port}` },
      ]);
    const cdp = await app.context().newCDPSession(page);
    const log: string[] = [];
    const urls: string[] = [];
    const failures: string[] = [];
    cdp.on('Log.entryAdded', ({ entry }) => log.push(`${entry.url ?? ''} ${entry.text}`));
    cdp.on('Runtime.consoleAPICalled', ({ args }) => {
      for (const arg of args) log.push(String(arg.value ?? arg.description ?? ''));
    });
    cdp.on('Network.requestWillBeSent', ({ request }) => urls.push(request.url));
    cdp.on('Network.loadingFailed', ({ errorText }) => failures.push(errorText));
    await Promise.all([cdp.send('Log.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
    await page.waitForFunction(() => Boolean(window.previewPrivacy));

    // Verify this Chromium session exposes both original failure markers.
    await page.evaluate(
      async ({ path, imageSources }) => {
        await fetch('/api/fs/stream?' + new URLSearchParams({ kind: 'project', relative_path: path }));
        for (const source of imageSources) {
          const img = new Image();
          img.src = source;
          await img.decode().catch(() => undefined);
        }
      },
      { path: PATH_MARKER, imageSources: [INVALID_IMAGE, INVALID_CHARSET] }
    );
    await expect.poll(() => log.some((entry) => entry.includes('relative_path=private+folder'))).toBe(true);
    await expect.poll(() => log.some((entry) => entry.includes(IMAGE_MARKER))).toBe(true);
    await expect.poll(() => log.some((entry) => entry.includes(CHARSET_MARKER))).toBe(true);
    log.length = urls.length = failures.length = 0;

    const denied = await page.evaluate(async (file) => {
      try {
        await window.previewPrivacy.download(file, 'report.pdf');
        return 'download succeeded';
      } catch (error) {
        return (error as Error).message;
      }
    }, REQUEST_FILE);
    expect(denied).toBe('File download failed (403)');
    expect(lastDownload).toEqual({
      url: '/api/fs/content',
      method: 'POST',
      accept: 'application/octet-stream',
      csrf: 'fixture-csrf',
      body: { file: REQUEST_FILE, encoding: 'base64' },
    });
    await expect.poll(() => log.some((entry) => entry.includes('/api/fs/content') && entry.includes('403'))).toBe(true);

    for (const content of [INVALID_IMAGE, INVALID_CHARSET]) {
      await page.evaluate((source) => window.previewPrivacy.openImage({ content: source }), content);
      await expect(page.getByText('Failed to load image')).toBeVisible();
      await expect(page.locator('img')).toHaveCount(0);
    }
    await page.evaluate((content) => window.previewPrivacy.openImage({ content }), SVG);
    await expect.poll(() => page.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(2);
    await page.evaluate((fileRef) => window.previewPrivacy.openImage({ fileRef }), REQUEST_FILE);
    await expect(page.getByText('Failed to load image')).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);

    const markers = /relative_path=|private[+% ]|cHJpdmF0ZS1pbWFnZS1ieXRlcw|cHJpdmF0ZS1jaGFyc2V0|net::ERR_INVALID_URL/;
    expect([...log, ...urls, ...failures].filter((entry) => markers.test(entry))).toEqual([]);

    for (const mode of ['stream', 'legacy'] as const) {
      downloadResponse = mode;
      const bytes = await page.evaluate(async (file) => {
        const createObjectURL = URL.createObjectURL;
        let download: Promise<ArrayBuffer> | undefined;
        const cancelNavigation = (event: MouseEvent) => event.preventDefault();
        document.addEventListener('click', cancelNavigation, { once: true });
        URL.createObjectURL = (blob: Blob) => {
          download = blob.arrayBuffer();
          return createObjectURL(blob);
        };
        try {
          await window.previewPrivacy.download(file, 'report.pdf');
          return Array.from(new Uint8Array(await download));
        } finally {
          URL.createObjectURL = createObjectURL;
          document.removeEventListener('click', cancelNavigation);
        }
      }, REQUEST_FILE);
      expect(bytes).toEqual([0, 255, 42]);
    }
  } finally {
    await app?.close();
    server.close();
    await rm(sandbox, { recursive: true, force: true });
  }
});
