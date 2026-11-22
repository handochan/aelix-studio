/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { chromium, expect, test, type Browser, type Locator } from '@playwright/test';
import { build } from 'esbuild';
import { createGenerator } from 'unocss';
import unoConfig from '../../../../../uno.config';

// Renders the real notices and status bar in the composer order with the app's CSS, then
// hit-tests every action at its center. jsdom has no layout, so this runs in Chromium.
const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import '@arco-design/web-react/es/_util/react-19-adapter';
import '@arco-design/web-react/dist/css/arco.css';
import '@/renderer/styles/arco-override.css';
import '@/renderer/styles/themes/index.css';
import ThoughtDisplay from '@/renderer/components/chat/ThoughtDisplay';
import { RunningInputNotices } from '@/renderer/pages/conversation/runtime/RunningInput';

const clicks = (window.__clicks = []);
const record = (name) => () => clicks.push(name);
const legacy = location.hash === '#legacy';
document.documentElement.setAttribute('data-theme', 'light');
document.documentElement.setAttribute('data-color-scheme', 'default');
void i18next.use(initReactI18next).init({ lng: 'en-US', resources: { 'en-US': { translation: {} } } });

const target = { bindingId: 'b', turnId: 't', mode: 'steer', hostTurnId: 'h' };
const image = {
  original: { width: 64, height: 1, bytes: 120 },
  sent: { width: 64, height: 1, bytes: 120, sha256: 'a'.repeat(64) },
  downscaled: false,
  orientationOnly: false,
};
const images = {
  modes: ['steer'],
  submission: { ...target, requestId: 'blocked', status: 'blocked', reason: 'model-text-only', allowPathOnly: true },
  receipts: [
    { receipt: { ...target, requestId: 'unknown', status: 'unknown', pixels: { images: [image], estimatedLineBytes: 300 } }, phase: 'active', canLookup: true },
  ],
  preview: () => undefined,
  dismissSubmission: record('dismiss-submission'),
  cancelPreparation: () => {},
  submitPaths: async () => 'sent',
};
const notices = React.createElement(RunningInputNotices, {
  notices: [],
  images,
  onDismiss: record('dismiss-receipt'),
  onCheck: record('check'),
  onSendPaths: record('send-paths'),
});
const status = React.createElement(ThoughtDisplay, { running: true, statusText: 'Running' });
const composer = React.createElement('div', { className: 'relative z-10 rd-20px bg-base', style: { height: 96 } });
createRoot(document.getElementById('root')).render(
  React.createElement(
    'div',
    { className: 'flex flex-col', style: { width: 720, margin: '160px auto 0' } },
    ...(legacy ? [status, notices, composer] : [notices, status, composer])
  )
);
`;

let server: Server;
let browser: Browser;
let origin: string;

test.beforeAll(async () => {
  const root = resolve('.');
  const bundle = await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: 'tsx', sourcefile: 'runningImageNotices.tsx' },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outdir: 'out',
    jsx: 'automatic',
    write: false,
    tsconfig: resolve(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.AIONUI_MULTI_INSTANCE': '""' },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    logLevel: 'silent',
  });
  const script = bundle.outputFiles.find(({ path }) => path.endsWith('.js'))!.text;
  const styles = bundle.outputFiles.find(({ path }) => path.endsWith('.css'))?.text ?? '';
  const uno = await createGenerator(unoConfig);
  const { css } = await uno.generate(script);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}\n${css}</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`;
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser?.close();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
});

/** Returns whether the element under the control's center belongs to that control. */
function hitsCenter(control: Locator) {
  return control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!hit && element.contains(hit);
  });
}

test('running image notices stay clickable above the running status bar', async () => {
  const page = await browser.newPage();
  await page.goto(origin);
  await expect(page.getByTestId('running-image-submission')).toBeVisible();
  const sendPaths = page.getByRole('button', { name: 'acp.runningInput.images.sendPaths' });
  const check = page.getByRole('button', { name: 'acp.runningInput.images.checkResult' });
  const dismiss = page.getByRole('button', { name: 'acp.runningInput.dismiss' });
  expect(await Promise.all([sendPaths, check, dismiss.nth(0), dismiss.nth(1)].map(hitsCenter))).toEqual([
    true,
    true,
    true,
    true,
  ]);

  // Real pointer clicks, not keyboard activation.
  await sendPaths.click();
  await check.click();
  await dismiss.nth(1).click();
  expect(await page.evaluate(() => (window as Window & { __clicks?: string[] }).__clicks)).toEqual([
    'send-paths',
    'check',
    'dismiss-receipt',
  ]);
  await page.close();
});

test('the status bar covers notices placed after it (control for the regression)', async () => {
  const page = await browser.newPage();
  await page.goto(origin + '#legacy');
  await expect(page.getByTestId('running-image-submission')).toBeVisible();
  expect(await hitsCenter(page.getByRole('button', { name: 'acp.runningInput.images.sendPaths' }))).toBe(false);
  await page.close();
});
