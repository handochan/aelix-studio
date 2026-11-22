/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import { createProxyCredentialVault, type SafeStorageLike } from '@process/services/ProxyCredentialVaultService';

/** A safeStorage stand-in: encryption reverses and tags the text, the backend is chosen per test. */
const fakeSafeStorage = (available: boolean, backend?: string): SafeStorageLike & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    isEncryptionAvailable: () => available,
    encryptString: (text) => {
      calls.push('encrypt');
      return Buffer.from('ENC:' + [...text].reverse().join(''));
    },
    decryptString: (sealed) => {
      calls.push('decrypt');
      const text = sealed.toString();
      if (!text.startsWith('ENC:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage');
      return Array.from(text.slice(4)).reverse().join('');
    },
    ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
  };
};

describe('the desktop proxy-credential vault', () => {
  it.each([
    ['macOS Keychain', 'darwin', undefined],
    ['Windows DPAPI', 'win32', undefined],
    ['Linux libsecret', 'linux', 'gnome_libsecret'],
    ['Linux KWallet', 'linux', 'kwallet5'],
  ] as const)('uses safeStorage with %s', (_case, platform, backend) => {
    const storage = fakeSafeStorage(true, backend);
    const vault = createProxyCredentialVault(storage, platform);
    expect(vault.mode).toBe('keychain');
    if (vault.mode !== 'keychain') return;
    const sealed = vault.seal('{"username":"ops","password":"hunter2"}');
    expect(sealed.toString()).not.toContain('hunter2');
    expect(vault.open(sealed)).toBe('{"username":"ops","password":"hunter2"}');
    expect(storage.calls).toEqual(['encrypt', 'decrypt']);
  });

  it.each([
    ['no encryption at all', 'darwin', false, undefined],
    ['Linux without a secret store (basic_text)', 'linux', true, 'basic_text'],
    ['Linux before a backend is chosen', 'linux', true, 'unknown'],
    ['Linux without a backend report', 'linux', true, undefined],
    ['Linux with no encryption', 'linux', false, 'gnome_libsecret'],
  ] as const)('keeps nothing for %s', (_case, platform, available, backend) => {
    const storage = fakeSafeStorage(available, backend);
    expect(createProxyCredentialVault(storage, platform)).toEqual({ mode: 'memory-only' });
    expect(storage.calls).toEqual([]);
  });

  it('lets a decryption failure reach the helper, which then asks again', () => {
    const vault = createProxyCredentialVault(fakeSafeStorage(true), 'darwin');
    if (vault.mode !== 'keychain') throw new Error('expected a keychain');
    expect(() => vault.open(Buffer.from('not sealed'))).toThrow();
  });

  it('reads Electron safeStorage by default', () => {
    expect(createProxyCredentialVault()).toEqual({ mode: 'memory-only' });
  });
});
