import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicReplace, renameReplacing, renameReplacingSync } from '@/process/storage/atomicFile';

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-atomic-'));
  file = path.join(directory, 'settings.txt');
  await fs.writeFile(file, 'previous');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('atomic file replacement', () => {
  it('keeps the old file readable until the complete new file replaces it', async () => {
    const rename = fs.rename.bind(fs);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replacement = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await waiting;
      return rename(from, to);
    });
    const write = atomicReplace(file, 'complete replacement');
    await vi.waitFor(() => expect(replacement).toHaveBeenCalled());
    expect(await fs.readFile(file, 'utf8')).toBe('previous');
    release?.();
    await write;
    expect(await fs.readFile(file, 'utf8')).toBe('complete replacement');
  });

  it('retains the old file and cleans the temporary when fsync fails', async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('synthetic fsync failure'));
      return handle;
    });
    await expect(atomicReplace(file, 'new')).rejects.toThrow('synthetic fsync failure');
    expect(await fs.readFile(file, 'utf8')).toBe('previous');
    expect(await fs.readdir(directory)).toEqual(['settings.txt']);
  });

  it.each(['EPERM', 'EACCES'])('never deletes the destination after a %s rename failure', async (code) => {
    vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('sharing violation'), { code }));
    await expect(atomicReplace(file, 'new')).rejects.toMatchObject({ code });
    expect(await fs.readFile(file, 'utf8')).toBe('previous');
    expect(await fs.readdir(directory)).toEqual(['settings.txt']);
  });

  it.skipIf(process.platform === 'win32')('reports a directory fsync failure after replacing the primary', async () => {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === directory) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('directory sync failed'));
      return handle;
    });
    await expect(atomicReplace(file, 'committed')).rejects.toThrow('directory sync failed');
    expect(await fs.readFile(file, 'utf8')).toBe('committed');
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries Windows %s with bounded backoff and keeps the old destination',
    async (code) => {
      const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('locked'), { code }));
      const sleeps: number[] = [];
      await expect(
        renameReplacing('candidate', file, 'win32', async (ms) => {
          sleeps.push(ms);
        })
      ).rejects.toMatchObject({ code });
      expect([rename.mock.calls.length, sleeps]).toEqual([4, [25, 50, 100]]);
      expect(await fs.readFile(file, 'utf8')).toBe('previous');
    }
  );

  it('succeeds when a transient Windows lock clears', async () => {
    const candidate = path.join(directory, 'candidate');
    await fs.writeFile(candidate, 'new');
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    await renameReplacing(candidate, file, 'win32', async () => {});
    expect(rename).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(file, 'utf8')).toBe('new');
  });

  it.each([
    ['win32', 'EIO'],
    ['linux', 'EPERM'],
  ] as const)('does not retry %s/%s', async (platform, code) => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('failed'), { code }));
    await expect(renameReplacing('candidate', file, platform, async () => {})).rejects.toMatchObject({ code });
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('uses the same bounded retry policy for synchronous profile recovery', () => {
    const rename = vi.spyOn(syncFs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('locked'), { code: 'EPERM' });
    });
    const delays: number[] = [];
    expect(() =>
      renameReplacingSync('candidate', file, 'win32', (ms) => {
        delays.push(ms);
      })
    ).toThrow('locked');
    expect([rename.mock.calls.length, delays]).toEqual([4, [25, 50, 100]]);
  });
});
