/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { on: vi.fn() } }));

let sandbox: string;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('AIONUI_E2E_TEST', '');
  vi.stubEnv('AIONUI_MULTI_INSTANCE', '');
  sandbox = mkdtempSync(path.join(tmpdir(), 'studio-storage-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

async function launchStorage(cliSafeAliases = false) {
  const { configureElectronIdentity, registerPlatformServices } = await import('@/common/platform');
  const { NodePlatformServices } = await import('@/common/platform/NodePlatformServices');
  const appData = path.join(sandbox, 'appData');
  let userData = path.join(appData, 'AionUi');
  const app = {
    isPackaged: true,
    getPath: (name: string) => (name === 'appData' ? appData : userData),
    setName: vi.fn(),
    setPath: (_name: string, value: string) => {
      userData = value;
    },
  };
  configureElectronIdentity(app);
  const platform = new NodePlatformServices();
  registerPlatformServices({
    ...platform,
    paths: {
      ...platform.paths,
      getDataDir: () => userData,
      isPackaged: () => true,
      getLogsDir: () => path.join(userData, 'logs'),
      getTempDir: () => sandbox,
      getHomeDir: () => sandbox,
      needsCliSafeSymlinks: () => cliSafeAliases,
    },
  });
  const storage = await import('@/process/utils/initStorage');
  await storage.default();
  return storage;
}

describe('Studio profile initialization', () => {
  it('leaves upstream profiles and temporary data intact on first launch', async () => {
    const oldProfile = path.join(sandbox, 'appData', 'AionUi', 'config');
    const oldTemp = path.join(sandbox, 'aionui');
    for (const directory of [oldProfile, oldTemp]) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, 'sentinel'), 'upstream');
    }

    const storage = await launchStorage();
    const { cacheDir, workDir, logDir } = storage.getSystemDir();
    const profile = path.join(sandbox, 'appData', 'Aelix Studio');
    expect({ cacheDir, workDir, logDir }).toEqual({
      cacheDir: path.join(profile, 'config'),
      workDir: path.join(profile, 'aionui'),
      logDir: path.join(profile, 'logs'),
    });
    expect(existsSync(path.join(cacheDir, 'sentinel'))).toBe(false);
    for (const directory of [oldProfile, oldTemp]) {
      expect(readFileSync(path.join(directory, 'sentinel'), 'utf8')).toBe('upstream');
    }
  });

  it('reads back settings saved under the Studio profile on restart', async () => {
    const first = await launchStorage();
    await first.ProcessConfig.set('language', 'ko-KR');

    vi.resetModules();
    const restarted = await launchStorage();
    expect(await restarted.ProcessConfig.get('language')).toBe('ko-KR');
  });

  it.skipIf(process.platform === 'win32')(
    'exposes a CLI alias that resolves to the extension-compatible Desktop profile',
    async () => {
      const storage = await launchStorage(true);
      await storage.ProcessConfig.set('language', 'ko-KR');
      const profile = realpathSync(path.join(sandbox, 'appData', 'Aelix Studio'));
      const alias = path.join(sandbox, '.aelix-studio');
      const database = realpathSync(alias);
      expect(path.basename(database)).toBe('aionui');
      expect(path.dirname(database)).toBe(profile);
      expect(existsSync(path.join(profile, 'config', 'aionui-config.txt'))).toBe(true);
    }
  );

  it('keeps the packaged and two development profiles distinct', async () => {
    const { configureElectronIdentity } = await import('@/common/platform');
    const app = { isPackaged: false, getPath: () => sandbox, setName: vi.fn(), setPath: vi.fn() };
    configureElectronIdentity(app);
    expect(app.setPath).toHaveBeenLastCalledWith('userData', path.join(sandbox, 'Aelix Studio-Dev'));
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '1');
    configureElectronIdentity(app);
    expect(app.setPath).toHaveBeenLastCalledWith('userData', path.join(sandbox, 'Aelix Studio-Dev-2'));
  });
});

describe('standalone WebUI profile selection', () => {
  it('isolates standalone production and development from desktop and upstream aliases', async () => {
    const { getStandaloneWebDataFolder } = await import('@/common/config/appIdentity');
    expect(getStandaloneWebDataFolder(true)).toBe('.aelix-studio-web');
    expect(getStandaloneWebDataFolder(false)).toBe('.aelix-studio-web-dev');
    expect(getStandaloneWebDataFolder(false, true)).toBe('.aelix-studio-web-dev-2');
  });
});

describe('Studio WebUI port defaults', () => {
  it('uses the Studio production port and respects the CLI, environment and stored overrides', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AIONUI_PORT', undefined);
    vi.stubEnv('PORT', undefined);
    await launchStorage();
    const { resolveWebUIPort } = await import('@/process/utils/webuiConfig');
    const unset = () => undefined;
    expect(resolveWebUIPort({}, unset)).toBe(25982);
    expect(resolveWebUIPort({ port: 25808 }, unset)).toBe(25808);
    vi.stubEnv('AIONUI_PORT', '33000');
    expect(resolveWebUIPort({ port: 25808 }, unset)).toBe(33000);
    expect(resolveWebUIPort({ port: 25808 }, (flag) => (flag === 'port' ? '34000' : undefined))).toBe(34000);
  });
});
