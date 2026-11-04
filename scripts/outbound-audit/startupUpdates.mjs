/** Qualify default-on updates on every actual session, without creating one early. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { isolatedAppEnvironment } from './startup.mjs';

/** Serialized into Electron's main process; never reads session.defaultSession. */
export function installStartupUpdateProbe({ app, webContents, dialog }) {
  globalThis.__studioUpdateRequests = [];
  globalThis.__studioUpdateDialogs = 0;
  dialog.showErrorBox = () => {
    globalThis.__studioUpdateDialogs++;
  };
  const seen = new WeakSet();
  const monitor = (created) => {
    if (seen.has(created)) return;
    seen.add(created);
    created.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const local =
        !['http:', 'https:'].includes(url.protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (!local) globalThis.__studioUpdateRequests.push(details.url);
      callback({ cancel: !local });
    });
  };
  app.on('session-created', monitor);
  app.on('web-contents-created', (_event, contents) => monitor(contents.session));
  for (const contents of webContents.getAllWebContents()) monitor(contents.session);
}

async function main() {
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
    app = await electron.launch({
      executablePath: process.env.PROVIDER_APP_EXECUTABLE,
      env,
      cwd: root,
      timeout: 60000,
    });
    await app.evaluate(installStartupUpdateProbe);
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
    await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
    // Exercise the installed app's own local dictionary handler in a fresh session.
    report.spelling = await app.evaluate(async ({ session, BrowserWindow }) => {
      if (process.platform !== 'linux') return { scope: 'native-not-probed' };
      const created = session.fromPartition('offline-spellcheck-' + Date.now());
      let timer;
      const initialized = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Installed local dictionary timeout')), 20000);
        created.once('spellcheck-dictionary-initialized', () => {
          clearTimeout(timer);
          resolve();
        });
        created.once('spellcheck-dictionary-download-failure', () => {
          clearTimeout(timer);
          reject(new Error('Installed local dictionary failed'));
        });
      });
      created.setSpellCheckerLanguages(['en-US']);
      const window = new BrowserWindow({
        show: false,
        webPreferences: { session: created, spellcheck: true, nodeIntegration: true, contextIsolation: false },
      });
      try {
        await Promise.all([window.loadURL('data:text/html,<textarea>helooo</textarea>'), initialized]);
        const words = await window.webContents.executeJavaScript(
          "({wrong:require('electron').webFrame.isWordMisspelled('helooo'),correct:require('electron').webFrame.isWordMisspelled('hello'),suggestions:require('electron').webFrame.getWordSuggestions('helooo')})"
        );
        if (!words.wrong || words.correct || !words.suggestions.includes('hello'))
          throw new Error('Installed spelling correction mismatch');
        return { scope: 'installed-linux', loaded: true, corrected: true };
      } finally {
        clearTimeout(timer);
        window.destroy();
      }
    });
    await page.waitForTimeout(7000);
    const evidence = await app.evaluate(() => ({
      requests: globalThis.__studioUpdateRequests,
      errorDialogs: globalThis.__studioUpdateDialogs,
    }));
    report.observedHosts = [...new Set(evidence.requests.map((url) => new URL(url).host))];
    const releases = evidence.requests.filter((url) =>
      /^https:\/\/(?:github.com\/handochan\/aelix-studio\/releases|api.github.com\/repos\/handochan\/aelix-studio\/releases)(?:[/.?]|$)/.test(
        url
      )
    );
    assert.ok(releases.length > 0, 'Default-on startup must request Studio Releases');
    assert.deepEqual(evidence.requests, releases, 'Default-on checks must request only Studio Releases');
    assert.equal(evidence.errorDialogs, 0, 'Blocked startup checks must not display error dialogs');
    report.updateRequests = releases;
    report.errorDialogs = evidence.errorDialogs;
    report.status = 'passed';
  } catch (error) {
    report.errorKind = error?.name ?? 'Error';
    throw error;
  } finally {
    await app?.close();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
