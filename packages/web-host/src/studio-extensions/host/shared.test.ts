/** The one extension helper service of a host process, and where it finds the bundled runtime. */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeBundle, fakeRuntime } from '../../../tests/fixtures/extensionRuntime';
import type { ProxyCredentialVault } from '../flow/online/proxy/credentials';
import type { ExtensionSettingsState } from '../types';
import {
  configureStudioExtensions,
  disposeStudioExtensions,
  getStudioExtensionService,
  studioRuntimeDirectory,
} from './shared';

const keychain: ProxyCredentialVault = { mode: 'keychain', seal: (text) => Buffer.from(text), open: String };

describe('the extension helper service of a host process', () => {
  let scratch = '';
  beforeEach(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-extensions-host-')));
  });
  afterEach(async () => {
    await disposeStudioExtensions();
    await rm(scratch, { recursive: true, force: true });
  });

  it('is absent until the host configures it, and the first configuration stands', async () => {
    expect(getStudioExtensionService()).toBeUndefined();
    const bundle = await createFakeBundle(path.join(scratch, 'bundle'));
    const first = configureStudioExtensions({
      userDataPath: path.join(scratch, 'user data'),
      runtime: bundle,
      proxyVault: keychain,
      service: { spawn: fakeRuntime({ bundle }) },
    });
    expect(getStudioExtensionService()).toBe(first);
    // A second host call cannot swap the vault, and so the credential mode, under it.
    expect(configureStudioExtensions({ userDataPath: path.join(scratch, 'other') })).toBe(first);
    const reply = await first.request('desktop:1', { action: 'get_settings' });
    expect(reply.ok && (reply.data as ExtensionSettingsState).credentialMode).toBe('keychain');
  });

  it('keeps its state in <user data>/aelix-runtime and is memory-only without a vault', async () => {
    const bundle = await createFakeBundle(path.join(scratch, 'bundle'));
    const userData = path.join(scratch, 'user data');
    const service = configureStudioExtensions({
      userDataPath: userData,
      runtime: bundle,
      service: { spawn: fakeRuntime({ bundle }) },
    });
    const reply = await service.request('web:operator', { action: 'set_settings', settings: { privateGit: true } });
    expect(reply.ok && (reply.data as ExtensionSettingsState).credentialMode).toBe('memory-only');
    await expect(realpath(path.join(userData, 'aelix-runtime', 'settings.json'))).resolves.toBeTruthy();
  });

  it('is forgotten and stopped when disposed', async () => {
    const bundle = await createFakeBundle(path.join(scratch, 'bundle'));
    configureStudioExtensions({ userDataPath: scratch, runtime: bundle });
    await disposeStudioExtensions();
    expect(getStudioExtensionService()).toBeUndefined();
    await disposeStudioExtensions();
  });

  describe('the bundled runtime', () => {
    const resources = process as NodeJS.Process & { resourcesPath?: string };
    let before: string | undefined;
    beforeEach(() => {
      before = resources.resourcesPath;
    });
    afterEach(() => {
      resources.resourcesPath = before;
    });

    /** A runtime native auth accepts: launcher, manifest for this platform, interpreter, entry. */
    const runtimeAt = async (directory: string): Promise<string> => {
      await mkdir(path.join(directory, 'python', ...(process.platform === 'win32' ? [] : ['bin'])), {
        recursive: true,
      });
      await writeFile(path.join(directory, 'launch.cjs'), '');
      await writeFile(path.join(directory, 'launch.py'), '');
      await writeFile(
        path.join(directory, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])),
        ''
      );
      await writeFile(
        path.join(directory, 'manifest.json'),
        JSON.stringify({ schema: 'aelix.studio-preview.runtime/1', target: `${process.platform}-${process.arch}` })
      );
      return directory;
    };

    it('is AELIX_STUDIO_RUNTIME first, then the packaged resources, then a checkout, each validated as native auth does', async () => {
      const cwd = path.join(scratch, 'checkout');
      const packaged = path.join(scratch, 'Resources', 'studio-preview');
      expect(studioRuntimeDirectory({ AELIX_STUDIO_RUNTIME: '/opt/runtime' }, cwd)).toBe('/opt/runtime');
      resources.resourcesPath = path.join(scratch, 'Resources');
      // Nothing valid: the checkout path, reported unavailable by the helper.
      expect(studioRuntimeDirectory({}, cwd)).toBe(path.join(cwd, '.local', 'studio-preview'));
      // A packaged directory with a manifest alone is not a runtime: the checkout one wins.
      await mkdir(packaged, { recursive: true });
      await writeFile(path.join(packaged, 'manifest.json'), '{}');
      await runtimeAt(path.join(cwd, '.local', 'studio-preview'));
      expect(studioRuntimeDirectory({}, cwd)).toBe(path.join(cwd, '.local', 'studio-preview'));
      // A complete packaged runtime comes first.
      await runtimeAt(packaged);
      expect(studioRuntimeDirectory({}, cwd)).toBe(packaged);
    });
  });
});
