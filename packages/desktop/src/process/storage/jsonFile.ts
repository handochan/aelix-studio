/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import syncFs from 'node:fs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { trackPersistedWrite } from '../utils/persistOnQuit';
import { atomicReplace, atomicReplaceSync, cleanupStorageTemps } from './atomicFile';

const encode = (data: unknown): string => btoa(encodeURIComponent(JSON.stringify(data)));

function decode<S extends object>(raw: string): S {
  if (!raw.trim()) throw new Error('empty file');
  let json: string;
  try {
    json = decodeURIComponent(atob(raw));
  } catch {
    throw new Error('invalid encoding');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('invalid JSON');
  }
  if (value === null || typeof value !== 'object') throw new Error('invalid storage value');
  return value as S;
}

type StoreOptions<S> = { empty?: () => S; onReset?: (preservedFile: string) => void };

/** A serialized JSON store that preserves damaged profiles before resetting them. */
export function createJsonFileStore<S extends object = Record<string, unknown>>(
  file: string,
  options: StoreOptions<S> = {}
) {
  const lastGoodFile = `${file}.bak`;
  let cache: S | null = null;
  let lastGoodRaw: string | undefined;
  let recoveryRaw: string | undefined;
  let writeChain: Promise<unknown> = Promise.resolve();
  const empty = options.empty ?? (() => ({}) as S);

  const load = (): S => {
    cleanupStorageTemps(file);
    cleanupStorageTemps(lastGoodFile);
    let primary: Buffer;
    let primaryReason: string;
    try {
      primary = syncFs.readFileSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Deleting the primary is an intentional reset. Ignore a stale backup;
      // the first save replaces it with the new profile's values.
      if (code === 'ENOENT') return empty();
      throw new Error(`[Storage] Cannot read ${file}: ${code}`, { cause: error });
    }
    try {
      const raw = primary.toString('utf8');
      const value = decode<S>(raw);
      lastGoodRaw = raw;
      return value;
    } catch (error) {
      primaryReason = (error as Error).message;
    }
    let recovered: S | undefined;
    let recoveredRaw: string | undefined;
    let backup: Buffer | undefined;
    try {
      backup = syncFs.readFileSync(lastGoodFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT')
        throw new Error(`[Storage] Cannot read recovery copy ${lastGoodFile}: ${code}`, { cause: error });
    }
    if (backup !== undefined) {
      try {
        const raw = backup.toString('utf8');
        recovered = decode<S>(raw);
        recoveredRaw = raw;
      } catch {
        // Preserve the bytes already read when the backup contents are damaged.
      }
    }
    const preserved = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    // Config writes its durable update-suppression marker before preservation,
    // so a process exit between quarantine and reset cannot re-enable checks.
    if (!recovered) options.onReset?.(preserved);
    // Keep the primary present until its atomic replacement. An exit between
    // preservation and recovery must not look like an intentional deletion.
    atomicReplaceSync(preserved, primary);
    console.warn(`[Storage] Preserved damaged ${file} at ${preserved} (${primaryReason})`);
    if (recovered && recoveredRaw !== undefined) {
      atomicReplaceSync(file, recoveredRaw);
      lastGoodRaw = recoveredRaw;
      recoveryRaw = recoveredRaw;
      console.warn(`[Storage] Recovering ${file} from last-good copy`);
      return recovered;
    }
    if (backup !== undefined) {
      const preservedBackup = `${lastGoodFile}.corrupt-${Date.now()}-${randomUUID()}`;
      atomicReplaceSync(preservedBackup, backup);
      console.warn(`[Storage] Preserved damaged backup at ${preservedBackup}`);
    }
    const value = empty();
    const encoded = encode(value);
    atomicReplaceSync(file, encoded);
    lastGoodRaw = encoded;
    console.warn(`[Storage] Started ${file} with empty settings after recovery failed`);
    return value;
  };

  const ensureLoaded = (): S => (cache ??= load());

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const operation = writeChain.then(work);
    writeChain = operation.catch(() => {});
    return trackPersistedWrite(operation);
  };

  const persist = (): Promise<S> => {
    const data = ensureLoaded();
    const encoded = encode(data);
    return enqueue(async () => {
      let committed = false;
      try {
        // Save only validated/committed data. A failed replacement cannot poison
        // the recovery copy, including the first save of a new profile.
        const previous = lastGoodRaw ?? encoded;
        if (recoveryRaw !== previous) {
          await atomicReplace(lastGoodFile, previous);
          recoveryRaw = previous;
        }
        await atomicReplace(file, encoded);
        lastGoodRaw = encoded;
        committed = true;
        // A successful OFF preference must also be the recovered value, rather
        // than reverting to an older ON preference if the primary is damaged.
        if (recoveryRaw !== encoded) {
          await atomicReplace(lastGoodFile, encoded);
          recoveryRaw = encoded;
        }
        return data;
      } catch (error) {
        const status = committed ? 'Primary saved but recovery copy refresh failed' : 'Failed to persist';
        console.error(`[Storage] ${status} ${file}:`, error);
        throw error;
      }
    });
  };

  return {
    async toJson(): Promise<S> {
      return ensureLoaded();
    },
    async setJson(data: S): Promise<S> {
      ensureLoaded();
      cache = data;
      return persist();
    },
    toJsonSync(): S {
      return ensureLoaded();
    },
    async set<K extends keyof S>(key: K, value: Awaited<S>[K]): Promise<Awaited<S>[K]> {
      ensureLoaded()[key] = value;
      await persist();
      return value;
    },
    async get<K extends keyof S>(key: K): Promise<Awaited<S>[K]> {
      return ensureLoaded()[key] as Awaited<S>[K];
    },
    async remove<K extends keyof S>(key: K): Promise<S> {
      delete ensureLoaded()[key];
      return persist();
    },
    async clear(): Promise<S> {
      ensureLoaded();
      cache = empty();
      return persist();
    },
    getSync<K extends keyof S>(key: K): S[K] {
      return ensureLoaded()[key];
    },
    update<K extends keyof S>(key: K, updateFn: (value: S[K], data: S) => Promise<S[K]>): Promise<S> {
      return trackPersistedWrite(
        (async () => {
          const data = ensureLoaded();
          data[key] = await updateFn(data[key], data);
          return persist();
        })()
      );
    },
    backup(fullName: string): Promise<void> {
      ensureLoaded();
      return enqueue(async () => {
        const raw = await fs.readFile(file, 'utf8');
        decode(raw);
        await atomicReplace(fullName, raw);
        // This API archives a conversation. Remove its recovery copy too, or a
        // subsequent lookup could resurrect the archived conversation.
        await fs.rm(lastGoodFile, { force: true });
        await fs.rm(file);
        cache = null;
        lastGoodRaw = undefined;
        recoveryRaw = undefined;
      });
    },
  };
}
