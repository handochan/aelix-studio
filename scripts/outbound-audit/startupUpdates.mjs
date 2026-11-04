/** Separately qualify default-on update checks with requests cancelled before egress. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { isolatedAppEnvironment } from './startup.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-default-updates-'));
const output = process.argv[2];
const report = {
  schema: 'aelix-studio.default-update-check/1',
  status: 'failed',
  automaticCheckSetting: 'absent-default-on',
  networkBlocked: true,
  credentials: false,
};
let app;
try {
  const env = isolatedAppEnvironment(root);
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'AELIX_CODING_AGENT_DIR',
    'AELIX_CODING_AGENT_SESSION_DIR',
  ])
    fs.mkdirSync(env[key], { recursive: true });
  app = await electron.launch({ executablePath: process.env.PROVIDER_APP_EXECUTABLE, env, cwd: root, timeout: 60000 });
  await app.evaluate(({ session, dialog }) => {
    globalThis.__studioUpdateRequests = [];
    globalThis.__studioUpdateDialogs = 0;
    dialog.showErrorBox = () => {
      globalThis.__studioUpdateDialogs++;
    };
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const local =
        !['http:', 'https:'].includes(url.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!local) globalThis.__studioUpdateRequests.push(details.url);
      callback({ cancel: !local });
    });
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
  await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(7000);
  const evidence = await app.evaluate(() => ({
    requests: globalThis.__studioUpdateRequests,
    errorDialogs: globalThis.__studioUpdateDialogs,
  }));
  const releases = evidence.requests.filter((url) =>
    /^https:\/\/(?:github.com\/handochan\/aelix-studio\/releases|api.github.com\/repos\/handochan\/aelix-studio\/releases)(?:[/.?]|$)/.test(
      url
    )
  );
  assert.ok(releases.length > 0, 'Default-on startup must request Studio Releases');
  assert.equal(evidence.errorDialogs, 0, 'Blocked startup checks must not display error dialogs');
  report.updateRequests = releases;
  report.errorDialogs = evidence.errorDialogs;
  report.status = 'passed';
} finally {
  await app?.close();
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
}
