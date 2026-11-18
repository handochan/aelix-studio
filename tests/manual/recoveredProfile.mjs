import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import {
  closeElectron,
  configSummary,
  electronAppEnvironment,
} from '../../scripts/studio-preview/host-release/verification.mjs';

/** Exercise actual installed startup from an older build's empty configuration. */
export async function qualifyRecoveredProfile({ executablePath, environment, root, record }) {
  const studio = path.join(root, 'studio');
  const file = path.join(studio, 'config/aionui-config.txt');
  const env = electronAppEnvironment({
    ...environment,
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'home/config'),
    XDG_CACHE_HOME: path.join(root, 'home/cache'),
    APPDATA: path.join(root, 'home/appdata'),
    LOCALAPPDATA: path.join(root, 'home/localappdata'),
    AIONUI_E2E_TEST: '1',
    AIONUI_E2E_USER_DATA_DIR: studio,
    AIONUI_EXTENSIONS_PATH: path.join(root, 'extensions'),
    AIONUI_EXTENSION_STATES_FILE: path.join(root, 'extension-states.json'),
    AELIX_CODING_AGENT_DIR: path.join(root, 'agent'),
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPYCACHEPREFIX: path.join(root, 'pycache'),
  });
  for (const key of ['AIONUI_BACKEND_BIN', 'AELIX_STUDIO_RUNTIME', 'AIONUI_BUNDLED_MANAGED_RESOURCES']) delete env[key];
  for (const directory of [
    path.dirname(file),
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.AIONUI_EXTENSIONS_PATH,
    env.AELIX_CODING_AGENT_DIR,
  ])
    fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, '', { flag: 'wx' });
  let app;
  let pid = null;
  record({ status: 'running', initialBytes: 0 });
  try {
    app = await electron.launch({ executablePath, args: [], cwd: root, env, timeout: 60000 });
    pid = app.process().pid;
    record({ status: 'launched', pid, initialBytes: 0 });
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.__backendPort > 0, undefined, { timeout: 60000 });
    await expect(page.getByTestId('guid-send-btn')).toBeVisible({ timeout: 30000 });
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    );
    assert.equal(visible, true, 'Recovery must display the main window');
    const readAutoCheck = () =>
      page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const name = 'system-settings:get-auto-update-enabled',
              id = 'recovered-profile-' + Date.now();
            let unsubscribe;
            const timer = setTimeout(() => {
              unsubscribe?.();
              reject(new Error('Recovery setting response timed out'));
            }, 10000);
            unsubscribe = window.electronAPI.on(({ value }) => {
              const result = JSON.parse(value);
              if (result.name === 'subscribe.callback-' + name + id) {
                clearTimeout(timer);
                unsubscribe();
                resolve(result.data);
              }
            });
            window.electronAPI.emit('subscribe-' + name, { id });
          })
      );
    assert.equal(await readAutoCheck(), false);
    await page.waitForTimeout(4000); // Cross the unchanged three-second startup check.
    assert.equal(await readAutoCheck(), false);
    const preserved = fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.startsWith('aionui-config.txt.corrupt-'));
    assert.equal(preserved.length, 1);
    assert.equal(fs.statSync(path.join(path.dirname(file), preserved[0])).size, 0);
    assert.equal(configSummary(file).autoCheck, false);
    assert.equal(fs.existsSync(`${file}.recovery.json`), true);
    await closeElectron(app);
    app = null;
    assert.equal(configSummary(file).autoCheck, false);
    record({
      status: 'passed',
      pid,
      initialBytes: 0,
      windowVisible: visible,
      effectiveAutoCheck: false,
      config: configSummary(file),
      preservedBytes: 0,
      preservedFiles: preserved.length,
      startupCheckDelayCovered: true,
    });
  } catch (error) {
    record({ status: 'failed', pid, initialBytes: 0, config: configSummary(file), error: String(error) });
    throw error;
  } finally {
    if (app) {
      await closeElectron(app).catch(() => {});
    }
  }
}
