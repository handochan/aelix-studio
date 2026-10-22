import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync } from 'fs';
import path from 'path';
import os from 'os';

const state = vi.hoisted(() => ({ home: '', data: '' }));
vi.mock('@/common/platform', () => ({
  getPlatformServices: () => ({
    paths: {
      getHomeDir: () => state.home,
      getDataDir: () => state.data,
      needsCliSafeSymlinks: () => true,
      isPackaged: () => true,
    },
  }),
}));
import { getDataPath, getConfigPath } from '@/process/utils/utils';

describe('Studio path isolation', () => {
  let temp: string;
  beforeEach(() => {
    temp = mkdtempSync(path.join(os.tmpdir(), 'studio-path-'));
    state.home = path.join(temp, 'home');
    state.data = path.join(temp, 'Application Support', 'Aelix Studio');
    mkdirSync(state.home);
    vi.stubEnv('AIONUI_E2E_TEST', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  });
  it('keeps existing AionUi aliases pointing to their original data', () => {
    symlinkSync('/original/aionui/data', path.join(state.home, '.aionui'));
    symlinkSync('/original/aionui/config', path.join(state.home, '.aionui-config'));
    getDataPath();
    getConfigPath();
    expect(readlinkSync(path.join(state.home, '.aionui'))).toBe('/original/aionui/data');
    expect(readlinkSync(path.join(state.home, '.aionui-config'))).toBe('/original/aionui/config');
  });
  it('creates a distinct CLI-safe alias for Studio', () => {
    expect(getDataPath()).toBe(path.join(state.home, '.aelix-studio'));
    expect(readlinkSync(path.join(state.home, '.aelix-studio'))).toBe(path.join(state.data, 'aionui'));
  });
  it('preserves a real directory that occupies the Studio alias', () => {
    mkdirSync(path.join(state.home, '.aelix-studio'));
    expect(getDataPath()).toBe(path.join(state.data, 'aionui'));
    expect(lstatSync(path.join(state.home, '.aelix-studio')).isDirectory()).toBe(true);
  });
  it('keeps E2E profiles inside their sandbox without home aliases', () => {
    vi.stubEnv('AIONUI_E2E_TEST', '1');
    expect(getDataPath()).toBe(path.join(state.data, 'aionui'));
    expect(() => lstatSync(path.join(state.home, '.aelix-studio'))).toThrow();
  });
});
