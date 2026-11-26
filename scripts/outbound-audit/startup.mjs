/** Audit production defaults without the E2E/CI/update-disable environment guards. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

export function isolatedAppEnvironment(root, source = process.env) {
  const environment = {};
  for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'TMP', 'TEMP']) {
    if (source[key]) environment[key] = source[key];
  }
  return {
    ...environment,
    PATH: process.platform === 'win32' ? `${source.SystemRoot}\\System32;${source.SystemRoot}` : '/usr/bin:/bin',
    CFFIXED_USER_HOME: path.join(root, 'home'),
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    AELIX_CODING_AGENT_DIR: path.join(root, 'agent'),
    AELIX_CODING_AGENT_SESSION_DIR: path.join(root, 'sessions'),
    AELIX_AUTH_PATH: path.join(root, 'agent', 'auth.json'),
  };
}

/** Use the app's normal document guest and verify loopback loading and blocked external assets. */
export async function qualifyOfflinePreview(page, root) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'http://192.0.2.5/image.svg' }).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const documentPath = path.join(root, 'offline-preview.html');
    const localImage = 'http://127.0.0.1:' + port;
    fs.writeFileSync(
      documentPath,
      `<!doctype html><link rel="preconnect" href="http://192.0.2.5">
      <link rel="stylesheet" href="http://192.0.2.5/report.css">
      <img id="local" src="${localImage}/local.svg">
      <img id="redirect" src="${localImage}/redirect">
      <img id="external" src="http://192.0.2.5/image.svg">
      <script src="http://192.0.2.5/report.js"></script>`
    );
    const widths = await page.evaluate(
      (src) =>
        new Promise((resolve, reject) => {
          const guest = document.createElement('webview');
          guest.src = src;
          guest.style.cssText = 'position:fixed;width:16px;height:16px';
          const timer = setTimeout(() => {
            guest.remove();
            reject(new Error('Document guest did not finish'));
          }, 15000);
          guest.addEventListener(
            'did-finish-load',
            async () => {
              try {
                resolve(
                  await guest.executeJavaScript(
                    "['local', 'redirect', 'external'].map((id) => document.getElementById(id).naturalWidth)"
                  )
                );
              } catch (error) {
                reject(error);
              } finally {
                clearTimeout(timer);
                guest.remove();
              }
            },
            { once: true }
          );
          document.body.append(guest);
        }),
      pathToFileURL(documentPath).href
    );
    assert.deepEqual(widths, [1, 0, 0], 'Local image loads and external and redirected images are blocked');
    assert.deepEqual([...requests].sort(), ['/local.svg', '/redirect']);
    return { localImage: true, externalImage: false, externalRedirect: false };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const executablePath = process.env.PROVIDER_APP_EXECUTABLE;
  const output = process.argv[2];
  const offlineMode = process.argv.includes('--offline-mode');
  assert.ok(executablePath && output, 'Installed app path and report path are required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-default-outbound-'));
  const environment = isolatedAppEnvironment(root);
  for (const key of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'AELIX_CODING_AGENT_DIR',
    'AELIX_CODING_AGENT_SESSION_DIR',
  ]) {
    fs.mkdirSync(environment[key], { recursive: true });
  }
  const profile = path.join(environment.XDG_CONFIG_HOME, 'Aelix Studio');
  const upstreamProfile = path.join(environment.XDG_CONFIG_HOME, 'AionUi');
  fs.mkdirSync(upstreamProfile);
  fs.writeFileSync(path.join(upstreamProfile, 'sentinel'), 'upstream');
  const config = path.join(profile, 'config/aionui-config.txt');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(
    config,
    Buffer.from(
      encodeURIComponent(
        JSON.stringify(offlineMode ? { 'network.offlineMode': true, language: 'en-US' } : { 'update.autoCheck': false })
      )
    ).toString('base64')
  );
  const report = {
    schema: 'aelix-studio.default-startup/1',
    status: 'failed',
    e2eGuard: false,
    ciGuard: false,
    realCredentials: false,
    observationMs: 35000,
    offlineMode,
  };
  let app;
  try {
    app = await electron.launch({ executablePath, args: [], cwd: root, env: environment, timeout: 60000 });
    const paths = await app.evaluate(({ app }) => ({
      name: app.getName(),
      userData: app.getPath('userData'),
      logs: app.getPath('logs'),
    }));
    assert.deepEqual(paths, { name: 'Aelix Studio', userData: profile, logs: path.join(profile, 'logs') });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
    await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveTitle('Aelix Studio');
    assert.deepEqual(fs.readdirSync(upstreamProfile), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(upstreamProfile, 'sentinel'), 'utf8'), 'upstream');
    assert.ok(fs.readdirSync(paths.logs, { recursive: true }).some((entry) => String(entry).endsWith('.log')));
    report.studioProfile = true;
    if (offlineMode) {
      await page.evaluate(() => {
        window.location.hash = '/settings/about';
      });
      await expect(page.getByRole('switch', { name: 'Offline mode' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
      await expect(page.getByText('Update checks are disabled in offline mode.')).toBeVisible();
      report.preview = await qualifyOfflinePreview(page, root);
    }
    // Covers the old 3-second update and 30-second startup-log timers.
    await page.waitForTimeout(report.observationMs);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
