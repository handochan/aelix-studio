/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Replace a file only after its same-directory temporary file has reached disk. */
export async function atomicReplace(file: string, data: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
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
    await fs.rename(temporary, file);
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
    await fs.rm(temporary, { force: true });
  }
}
