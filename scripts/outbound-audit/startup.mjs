/** Audit production defaults without the E2E/CI/update-disable environment guards. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';

export function isolatedAppEnvironment(root, source = process.env) {
  const environment = {};
  for (const key of ['SYSTEMROOT', 'SystemRoot', 'WINDIR', 'DISPLAY', 'XAUTHORITY', 'TMP', 'TEMP']) {
    if (source[key]) environment[key] = source[key];
  }
  return {
    ...environment,
    PATH: process.platform === 'win32' ? `${source.SystemRoot}\\System32;${source.SystemRoot}` : '/usr/bin:/bin',
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

async function main() {
  const executablePath = process.env.PROVIDER_APP_EXECUTABLE;
  const output = process.argv[2];
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
  const report = {
    schema: 'aelix-studio.default-startup/1',
    status: 'failed',
    e2eGuard: false,
    ciGuard: false,
    realCredentials: false,
    observationMs: 35000,
  };
  let app;
  try {
    app = await electron.launch({ executablePath, args: [], cwd: root, env: environment, timeout: 60000 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
    await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
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
