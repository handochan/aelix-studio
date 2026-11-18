import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicReplace, cleanupStorageTemps, STORAGE_TEMP_MAX_AGE_MS } from '@/process/storage/atomicFile';

let directory: string;
let file: string;
const uuid = '12345678-1234-1234-1234-123456789abc';
const name = (base: string, pid: number) => `.${base}.${pid}.${uuid}.tmp`;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-temps-'));
  file = path.join(directory, 'a[1].txt');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('owned storage temporary cleanup', () => {
  it('removes dead-owner and old inactive self files but keeps live foreign owners', async () => {
    const dead = name('a[1].txt', 999991),
      live = name('a[1].txt', 999992),
      own = name('a[1].txt', process.pid);
    for (const entry of [dead, live, own]) {
      await fs.writeFile(path.join(directory, entry), 'synthetic');
      await fs.utimes(path.join(directory, entry), 0, 0);
    }
    cleanupStorageTemps(file, { isAlive: (pid) => pid !== 999991 });
    expect(await fs.readdir(directory)).toEqual([live]);
  });

  it('matches only the exact store pattern and never removes preserved corrupt files', async () => {
    const untouched = [
      'a[1].txt',
      name('a1.txt', 999991),
      '.a[1].txt.999991.not-a-uuid.tmp',
      `a[1].txt.corrupt-123-${uuid}`,
      name('a[1].txt-other', 999991),
    ];
    for (const entry of untouched) await fs.writeFile(path.join(directory, entry), 'synthetic');
    const owned = name('a[1].txt', 999991);
    await fs.writeFile(path.join(directory, owned), 'stale');
    cleanupStorageTemps(file, { isAlive: () => false });
    expect((await fs.readdir(directory)).toSorted()).toEqual(untouched.toSorted());
  });

  it('also cleans abandoned copies being preserved under the store quarantine name', async () => {
    const entry = name(`a[1].txt.corrupt-123-${uuid}`, 999991);
    await fs.writeFile(path.join(directory, entry), 'synthetic');
    cleanupStorageTemps(file, { isAlive: () => false });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('does not delete an active self write even if its mtime looks old', async () => {
    const rename = fs.rename.bind(fs);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacing = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await waiting;
      return rename(from, to);
    });
    const write = atomicReplace(file, 'new');
    await vi.waitFor(() => expect(replacing).toHaveBeenCalled());
    cleanupStorageTemps(file, { now: Date.now() + 2 * STORAGE_TEMP_MAX_AGE_MS, isAlive: () => true });
    expect((await fs.readdir(directory)).some((entry) => entry.endsWith('.tmp'))).toBe(true);
    release?.();
    await write;
  });
});
