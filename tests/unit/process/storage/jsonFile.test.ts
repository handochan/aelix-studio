import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, quit } = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: { preventDefault: () => void }) => void>,
  quit: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    on: (name: string, fn: (event: { preventDefault: () => void }) => void) => {
      handlers[name] = fn;
    },
    quit,
  },
}));
import { createJsonFileStore } from '@/process/storage/jsonFile';
import { __resetPersistOnQuitForTests } from '@/process/utils/persistOnQuit';

const encode = (value: unknown) => btoa(encodeURIComponent(JSON.stringify(value)));
const decode = (raw: string): Record<string, unknown> => JSON.parse(decodeURIComponent(atob(raw)));
let directory: string;
let file: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-store-'));
  file = path.join(directory, 'settings.txt');
  __resetPersistOnQuitForTests();
  quit.mockReset();
  for (const key of Object.keys(handlers)) delete handlers[key];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('persisted JSON integrity', () => {
  it('treats only absence of both files as a new store', async () => {
    const store = createJsonFileStore(file);
    expect(store.toJsonSync()).toEqual({});
    await store.set('update.autoCheck', false);
    expect(decode(await fs.readFile(file, 'utf8'))).toEqual({ 'update.autoCheck': false });
    expect(decode(await fs.readFile(`${file}.bak`, 'utf8'))).toEqual({ 'update.autoCheck': false });
  });

  it.each(['', 'not base64!', btoa('%7B'), encode(null), encode(42)])(
    'preserves unreadable contents instead of applying defaults: %j',
    async (raw) => {
      await fs.writeFile(file, raw);
      const store = createJsonFileStore(file);
      await expect(store.set('update.autoCheck', true)).rejects.toThrow('files retained');
      expect(await fs.readFile(file, 'utf8')).toBe(raw);
      expect(await fs.readdir(directory)).toEqual(['settings.txt']);
    }
  );

  it.each(['clear', 'setJson'] as const)('does not bypass corruption detection through %s', async (method) => {
    await fs.writeFile(file, '');
    const store = createJsonFileStore(file);
    const result = method === 'clear' ? store.clear() : store.setJson({});
    await expect(result).rejects.toThrow('files retained');
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('recovers valid settings from the last-good copy with a diagnostic and repairs on save', async () => {
    await fs.writeFile(file, '');
    await fs.writeFile(`${file}.bak`, encode({ 'update.autoCheck': false }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createJsonFileStore(file);
    expect(store.getSync('update.autoCheck')).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Recovering'));
    await store.set('window.bounds', { width: 1024 });
    expect(decode(await fs.readFile(file, 'utf8'))['update.autoCheck']).toBe(false);
  });

  it('does not treat a missing primary with a damaged backup as a new store', async () => {
    await fs.writeFile(`${file}.bak`, '');
    expect(() => createJsonFileStore(file).toJsonSync()).toThrow('files retained');
    expect(await fs.readdir(directory)).toEqual(['settings.txt.bak']);
  });

  it('rejects a filesystem read error even when a recovery copy exists', async () => {
    await fs.mkdir(file);
    await fs.writeFile(`${file}.bak`, encode({ 'update.autoCheck': false }));
    await expect(createJsonFileStore(file).set('value', true)).rejects.toThrow('Cannot read');
    expect((await fs.stat(file)).isDirectory()).toBe(true);
  });

  it('does not disclose malformed setting contents in its error', async () => {
    await fs.writeFile(file, btoa(encodeURIComponent('{"secret":"SYNTHETIC_PRIVATE_VALUE')));
    expect(() => createJsonFileStore(file).toJsonSync()).toThrow('invalid JSON');
    try {
      createJsonFileStore(file).toJsonSync();
    } catch (error) {
      expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
    }
  });

  it('serializes writes while keeping the latest committed value in one backup', async () => {
    const store = createJsonFileStore(file);
    await Promise.all(Array.from({ length: 12 }, (_, value) => store.set('value', value)));
    expect(decode(await fs.readFile(file, 'utf8'))).toEqual({ value: 11 });
    expect(decode(await fs.readFile(`${file}.bak`, 'utf8'))).toEqual({ value: 11 });
    expect((await fs.readdir(directory)).toSorted()).toEqual(['settings.txt', 'settings.txt.bak']);
  });

  it('recovers a successfully disabled update preference without reverting to the older enabled value', async () => {
    await fs.writeFile(file, encode({ 'update.autoCheck': true }));
    await createJsonFileStore(file).set('update.autoCheck', false);
    await fs.writeFile(file, '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createJsonFileStore(file).getSync('update.autoCheck')).toBe(false);
  });

  it('preserves the committed primary and diagnoses a subsequent recovery-copy refresh failure', async () => {
    await fs.writeFile(file, encode({ 'update.autoCheck': true }));
    const rename = fs.rename.bind(fs);
    let backupRenames = 0;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === `${file}.bak` && ++backupRenames === 2) throw new Error('synthetic recovery failure');
      return rename(from, to);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createJsonFileStore(file).set('update.autoCheck', false)).rejects.toThrow(
      'synthetic recovery failure'
    );
    expect(decode(await fs.readFile(file, 'utf8'))['update.autoCheck']).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Primary saved'), expect.any(Error));
  });

  it('does not replace the good backup with a candidate whose primary rename failed', async () => {
    await fs.writeFile(file, encode({ 'update.autoCheck': false }));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file) throw Object.assign(new Error('primary locked'), { code: 'EPERM' });
      return rename(from, to);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(createJsonFileStore(file).set('update.autoCheck', true)).rejects.toThrow('primary locked');
    expect(decode(await fs.readFile(file, 'utf8'))['update.autoCheck']).toBe(false);
    expect(decode(await fs.readFile(`${file}.bak`, 'utf8'))['update.autoCheck']).toBe(false);
  });

  it('round-trips array stores used by conversation histories', async () => {
    await createJsonFileStore<string[]>(file).setJson(['message']);
    expect(createJsonFileStore<string[]>(file).toJsonSync()).toEqual(['message']);
  });

  it('archives without leaving a recovery file that can resurrect the conversation', async () => {
    const store = createJsonFileStore(file);
    await store.set('message', 'synthetic');
    const archive = path.join(directory, 'archive', 'conversation.txt');
    await store.backup(archive);
    expect(decode(await fs.readFile(archive, 'utf8'))).toEqual({ message: 'synthetic' });
    expect(createJsonFileStore(file).toJsonSync()).toEqual({});
    expect(store.toJsonSync()).toEqual({});
  });

  it('waits for an asynchronous update and its subsequently enqueued disk writes on quit', async () => {
    const store = createJsonFileStore(file);
    let resolve: ((value: unknown) => void) | undefined;
    const updating = store.update(
      'value',
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const preventDefault = vi.fn();
    handlers['will-quit']({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    resolve?.(false);
    await updating;
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
    expect(decode(await fs.readFile(file, 'utf8'))).toEqual({ value: false });
  });
});
