/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import syncFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const activeTemporaries = new Set<string>();
const RETRY_DELAYS_MS = [25, 50, 100];
export const STORAGE_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const transientRenameError = (error: unknown, platform: NodeJS.Platform): boolean =>
  platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '');

/** Retry only transient Windows sharing failures, without removing either file. */
export async function renameReplacing(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (!transientRenameError(error, platform) || attempt >= RETRY_DELAYS_MS.length) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/** Synchronous counterpart for import-time profile recovery. */
export function renameReplacingSync(
  from: string,
  to: string,
  platform: NodeJS.Platform = process.platform,
  sleep: (ms: number) => void = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      syncFs.renameSync(from, to);
      return;
    } catch (error) {
      if (!transientRenameError(error, platform) || attempt >= RETRY_DELAYS_MS.length) throw error;
      sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

const temporaryName = (file: string): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);

/** Commit recovered data before import-time readers can start another launch. */
export function atomicReplaceSync(file: string, data: string | Uint8Array): void {
  const directory = path.dirname(file);
  syncFs.mkdirSync(directory, { recursive: true });
  const temporary = temporaryName(file);
  activeTemporaries.add(temporary);
  try {
    const handle = syncFs.openSync(temporary, 'wx', 0o600);
    try {
      syncFs.writeFileSync(handle, data, 'utf8');
      syncFs.fsyncSync(handle);
    } finally {
      syncFs.closeSync(handle);
    }
    renameReplacingSync(temporary, file);
    if (process.platform !== 'win32') {
      const parent = syncFs.openSync(directory, 'r');
      try {
        syncFs.fsyncSync(parent);
      } finally {
        syncFs.closeSync(parent);
      }
    }
  } finally {
    activeTemporaries.delete(temporary);
    syncFs.rmSync(temporary, { force: true });
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and unknown errors cannot prove that another process is dead.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Remove only this file's abandoned temporaries; live foreign owners are protected. */
export function cleanupStorageTemps(
  file: string,
  { now = Date.now(), isAlive = processIsAlive }: { now?: number; isAlive?: (pid: number) => boolean } = {}
): void {
  const directory = path.dirname(file);
  const basename = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const pattern = new RegExp(`^\\.${basename}(?:\\.corrupt-[0-9]+-${uuid})?\\.([1-9][0-9]*)\\.${uuid}\\.tmp$`);
  try {
    for (const entry of syncFs.readdirSync(directory, { withFileTypes: true })) {
      const match = pattern.exec(entry.name);
      if (!match || !entry.isFile()) continue;
      const pid = Number(match[1]);
      const temporary = path.join(directory, entry.name);
      if (!Number.isSafeInteger(pid) || activeTemporaries.has(temporary)) continue;
      if (pid !== process.pid && isAlive(pid)) continue;
      try {
        const oldOwnFile = pid === process.pid && now - syncFs.statSync(temporary).mtimeMs > STORAGE_TEMP_MAX_AGE_MS;
        if (!oldOwnFile && isAlive(pid)) continue;
        if (pid !== process.pid && isAlive(pid)) continue;
        syncFs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn(`[Storage] Could not clean temporary ${temporary}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn(`[Storage] Could not inspect temporaries for ${file}`);
  }
}

/** Replace a file only after its same-directory temporary file has reached disk. */
export async function atomicReplace(file: string, data: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = temporaryName(file);
  activeTemporaries.add(temporary);
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Node replaces an existing file on Windows too. Never unlink the destination
    // as a fallback: a sharing violation must leave the previous file intact.
    await renameReplacing(temporary, file);
    // Windows does not expose directory fsync through this API.
    if (process.platform !== 'win32') {
      const parent = await fs.open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    activeTemporaries.delete(temporary);
    await fs.rm(temporary, { force: true });
  }
}
