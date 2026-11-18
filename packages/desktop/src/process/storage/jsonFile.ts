/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { trackPersistedWrite } from '../utils/persistOnQuit';
import { atomicReplace } from './atomicFile';

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

/** A serialized JSON store with atomic replacement and one last-known-good copy. */
export function createJsonFileStore<S extends object = Record<string, unknown>>(file: string) {
  const lastGoodFile = `${file}.bak`;
  let cache: S | null = null;
  let lastGoodRaw: string | undefined;
  let recoveryRaw: string | undefined;
  let writeChain: Promise<unknown> = Promise.resolve();

  const load = (): S => {
    let primaryReason: string;
    try {
      const raw = readFileSync(file, 'utf8');
      const value = decode<S>(raw);
      lastGoodRaw = raw;
      return value;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Permission and device failures must not be mistaken for a new profile.
      if (code && code !== 'ENOENT') throw new Error(`[Storage] Cannot read ${file}: ${code}`, { cause: error });
      primaryReason = code ?? (error as Error).message;
    }
    try {
      const raw = readFileSync(lastGoodFile, 'utf8');
      const value = decode<S>(raw);
      lastGoodRaw = raw;
      console.warn(`[Storage] Recovering ${file} from last-good copy (${primaryReason}); primary retained until save`);
      recoveryRaw = raw;
      return value;
    } catch (error) {
      if (primaryReason === 'ENOENT' && (error as NodeJS.ErrnoException).code === 'ENOENT') return {} as S;
      // Do not log decoded contents or parser messages containing stored values.
      throw new Error(`[Storage] Cannot load ${file}: ${primaryReason}; no readable last-good copy; files retained`, {
        cause: error,
      });
    }
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
      cache = {} as S;
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
