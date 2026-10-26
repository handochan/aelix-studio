/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyDefaultHostBundle } from '../../../../packages/shared-scripts/src/default-host.js';
import { resolveBinaryPath } from '@/process/backend/binaryResolver';

vi.mock('../../../../packages/shared-scripts/src/default-host.js', () => ({ verifyDefaultHostBundle: vi.fn() }));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const originalBackendBin = process.env.AIONUI_BACKEND_BIN;

function setResourcesPath(resourcesPath: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });
}

function restoreBackendBin(): void {
  if (originalBackendBin === undefined) {
    delete process.env.AIONUI_BACKEND_BIN;
  } else {
    process.env.AIONUI_BACKEND_BIN = originalBackendBin;
  }
}

function dirEntry(name: string, isDirectory = false): ReturnType<typeof readdirSync>[number] {
  return {
    name,
    isDirectory: () => isDirectory,
  } as unknown as ReturnType<typeof readdirSync>[number];
}

describe('resolveBinaryPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AIONUI_BACKEND_BIN;
  });

  afterEach(() => {
    setResourcesPath(originalResourcesPath);
    restoreBackendBin();
  });

  it('returns the AIONUI_BACKEND_BIN override when the file exists', () => {
    const overrideInput = '/custom/aioncore';
    // Resolve mirrors the implementation so the expectation holds on Windows too.
    const overridePath = resolve(overrideInput);
    process.env.AIONUI_BACKEND_BIN = overrideInput;
    vi.mocked(existsSync).mockImplementation((path) => path === overridePath);

    expect(resolveBinaryPath()).toBe(overridePath);
    // Override wins before bundled/PATH lookup runs.
    expect(execSync).not.toHaveBeenCalled();
  });

  it('trims whitespace around AIONUI_BACKEND_BIN before use', () => {
    const overrideInput = '/custom/aioncore';
    const overridePath = resolve(overrideInput);
    process.env.AIONUI_BACKEND_BIN = `  ${overrideInput}  `;
    vi.mocked(existsSync).mockImplementation((path) => path === overridePath);

    expect(resolveBinaryPath()).toBe(overridePath);
  });

  it('resolves a relative AIONUI_BACKEND_BIN against process.cwd', () => {
    process.env.AIONUI_BACKEND_BIN = 'rel/aioncore';
    const absolute = resolve('rel/aioncore');
    vi.mocked(existsSync).mockImplementation((path) => path === absolute);

    expect(resolveBinaryPath()).toBe(absolute);
  });

  it('throws with override diagnostics when AIONUI_BACKEND_BIN points at a missing file', () => {
    const overrideInput = '/custom/missing-aioncore';
    const overridePath = resolve(overrideInput);
    process.env.AIONUI_BACKEND_BIN = overrideInput;
    vi.mocked(existsSync).mockReturnValue(false);

    // Error message quotes the raw input, diagnostics carry the resolved path.
    expect(() => resolveBinaryPath()).toThrow(`AIONUI_BACKEND_BIN is set to "${overrideInput}"`);

    try {
      resolveBinaryPath();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BackendBinaryResolveError',
        diagnostics: expect.objectContaining({
          envOverridePath: overridePath,
          envOverrideExists: false,
        }),
      });
    }
    // A missing explicit override fails loudly instead of falling back.
    expect(execSync).not.toHaveBeenCalled();
  });

  it('refuses PATH fallback when the default bundle is absent', () => {
    process.env.AIONUI_BACKEND_BIN = '   ';
    setResourcesPath(undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockReturnValue('/unqualified/aioncore');
    expect(() => resolveBinaryPath()).toThrow('Cannot find "aioncore" binary');
    expect(execSync).not.toHaveBeenCalled();
  });

  it('rejects a changed default bundle before any PATH lookup', () => {
    setResourcesPath('/owned/resources');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(verifyDefaultHostBundle).mockImplementation(() => {
      throw new Error('source policy differs');
    });
    expect(() => resolveBinaryPath()).toThrow('Default host bundle failed verification');
    expect(execSync).not.toHaveBeenCalled();
  });

  it('returns the verified default bundle', () => {
    setResourcesPath('/owned/resources');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(verifyDefaultHostBundle).mockReturnValue({});
    expect(resolveBinaryPath()).toBe(
      join(
        '/owned/resources',
        'bundled-aioncore',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'aioncore.exe' : 'aioncore'
      )
    );
    expect(execSync).not.toHaveBeenCalled();
  });

  it('attaches bundled path diagnostics when aioncore cannot be resolved', () => {
    const resourcesPath = '/app/resources';
    const runtimeKey = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'aioncore.exe' : 'aioncore';
    const bundledDir = join(resourcesPath, 'bundled-aioncore');
    const runtimeDir = join(bundledDir, runtimeKey);
    const checkedBundledPath = join(runtimeDir, binaryName);

    setResourcesPath(resourcesPath);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockImplementation((path) => {
      if (path === resourcesPath) return [dirEntry('bundled-aioncore', true)];
      if (path === runtimeDir) return [dirEntry('manifest.json')];
      return [] as ReturnType<typeof readdirSync>;
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found on PATH');
    });

    expect(() => resolveBinaryPath()).toThrow('Cannot find "aioncore" binary');

    try {
      resolveBinaryPath();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BackendBinaryResolveError',
        diagnostics: expect.objectContaining({
          resourcesPath,
          runtimeKey,
          binaryName,
          checkedBundledPath,
          bundledDirExists: false,
          runtimeDirExists: false,
          resourcesDirEntries: ['bundled-aioncore/'],
          runtimeDirEntries: ['manifest.json'],
          pathLookupCommand: process.platform === 'win32' ? 'where aioncore' : 'which aioncore',
        }),
      });
    }
  });
});
