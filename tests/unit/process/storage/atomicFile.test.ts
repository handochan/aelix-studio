import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicReplace } from '@/process/storage/atomicFile';

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
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('sharing violation'), { code }));
    await expect(atomicReplace(file, 'new')).rejects.toMatchObject({ code });
    expect(await fs.readFile(file, 'utf8')).toBe('previous');
    expect(await fs.readdir(directory)).toEqual(['settings.txt']);
  });
});
