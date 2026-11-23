/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { safeStorage } from 'electron';
import { EXTENSION_PROXY_MEMORY_ONLY_VAULT, type ProxyCredentialVault } from '@aionui/web-host';

/** The part of Electron `safeStorage` the vault uses. */
export type SafeStorageLike = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: which secret store backs the encryption. */
  getSelectedStorageBackend?(): string;
};

/**
 * Linux backends that are not a secret store. `basic_text` encrypts with a key built into
 * Chromium, which is as good as plain text on disk; `unknown` means none was chosen.
 */
const NOT_A_KEYCHAIN = new Set(['basic_text', 'unknown']);

/**
 * The proxy-credential vault the desktop app gives the Studio extension helper (Studio #32).
 *
 * `keychain` when Electron `safeStorage` encrypts with the OS keychain: macOS Keychain,
 * Windows DPAPI, Linux libsecret or KWallet. `memory-only` when it cannot (no encryption, or a
 * Linux `basic_text`/`unknown` backend): then nothing is saved and each install asks.
 *
 * On macOS nothing is asked of `safeStorage` here: even its availability check reads the
 * Keychain on the main thread and can wait for a Keychain prompt, which would hold app
 * startup. Every macOS user has a Keychain, so the vault is `keychain` and touches it only
 * when credentials are sealed or opened; a Keychain that refuses then makes the save fail
 * (`PROXY_CREDENTIALS_NOT_STORED`) and the open ask again.
 *
 * Call it after the app is ready; before that, Linux reports no backend yet.
 */
export function createProxyCredentialVault(
  storage: SafeStorageLike = safeStorage,
  platform: NodeJS.Platform = process.platform
): ProxyCredentialVault {
  if (platform !== 'darwin' && !storage.isEncryptionAvailable()) return EXTENSION_PROXY_MEMORY_ONLY_VAULT;
  if (platform === 'linux' && NOT_A_KEYCHAIN.has(storage.getSelectedStorageBackend?.() ?? 'unknown'))
    return EXTENSION_PROXY_MEMORY_ONLY_VAULT;
  return {
    mode: 'keychain',
    seal: (text) => storage.encryptString(text),
    open: (sealed) => storage.decryptString(sealed),
  };
}
