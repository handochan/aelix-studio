import fs from 'node:fs/promises';
import syncFs from 'node:fs';
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
  it('starts a new store when the primary is absent', async () => {
    const store = createJsonFileStore(file);
    expect(store.toJsonSync()).toEqual({});
    await store.set('update.autoCheck', false);
    expect(decode(await fs.readFile(file, 'utf8'))).toEqual({ 'update.autoCheck': false });
    expect(decode(await fs.readFile(`${file}.bak`, 'utf8'))).toEqual({ 'update.autoCheck': false });
  });

  it.each(['', 'not base64!', btoa('%7B'), encode(null), encode(42)])(
    'preserves damaged contents under a new name and starts with defaults: %j',
    async (raw) => {
      await fs.writeFile(file, raw);
      const store = createJsonFileStore(file);
      expect(store.toJsonSync()).toEqual({});
      const preserved = (await fs.readdir(directory)).find((name) => name.startsWith('settings.txt.corrupt-'));
      expect(await fs.readFile(path.join(directory, preserved!), 'utf8')).toBe(raw);
      await store.set('newValue', true);
      expect(decode(await fs.readFile(file, 'utf8'))).toEqual({ newValue: true });
    }
  );

  it.each(['clear', 'setJson'] as const)('allows %s after preserving corruption', async (method) => {
    await fs.writeFile(file, '');
    const store = createJsonFileStore(file);
    const result = method === 'clear' ? store.clear() : store.setJson({});
    await expect(result).resolves.toEqual({});
    expect(decode(await fs.readFile(file, 'utf8'))).toEqual({});
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

  it.each(['', encode({ oldSetting: true })])('ignores a stale backup after primary deletion: %j', async (backup) => {
    await fs.writeFile(`${file}.bak`, backup);
    const store = createJsonFileStore(file);
    expect(store.toJsonSync()).toEqual({});
    await store.set('newSetting', true);
    expect(decode(await fs.readFile(`${file}.bak`, 'utf8'))).toEqual({ newSetting: true });
  });

  it('rejects a filesystem read error even when a recovery copy exists', async () => {
    await fs.mkdir(file);
    await fs.writeFile(`${file}.bak`, encode({ 'update.autoCheck': false }));
    await expect(createJsonFileStore(file).set('value', true)).rejects.toThrow('Cannot read');
    expect((await fs.stat(file)).isDirectory()).toBe(true);
  });

  it.each(['EACCES', 'EIO'])('does not mistake backup %s for absence or overwrite its values', async (code) => {
    await fs.writeFile(file, '');
    const original = encode({ 'update.autoCheck': false });
    await fs.writeFile(`${file}.bak`, original);
    const read = syncFs.readFileSync.bind(syncFs);
    vi.spyOn(syncFs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === `${file}.bak`) throw Object.assign(new Error('synthetic unreadable backup'), { code });
      return read(...args);
    });
    vi.spyOn(syncFs, 'existsSync').mockReturnValue(false);
    await expect(createJsonFileStore(file).set('newValue', true)).rejects.toThrow('Cannot read recovery copy');
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe(original);
    expect(await fs.readFile(file, 'utf8')).toBe('');
  });

  it('preserves the exact malformed bytes of both primary and backup', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00]);
    await fs.writeFile(file, raw);
    await fs.writeFile(`${file}.bak`, raw);
    expect(createJsonFileStore(file).toJsonSync()).toEqual({});
    const preserved = (await fs.readdir(directory)).filter((name) => name.includes('.corrupt-'));
    expect(preserved.length).toBe(2);
    expect(await Promise.all(preserved.map((name) => fs.readFile(path.join(directory, name))))).toEqual([raw, raw]);
  });

  it('does not disclose malformed setting contents in recovery diagnostics', async () => {
    await fs.writeFile(file, btoa(encodeURIComponent('{"secret":"SYNTHETIC_PRIVATE_VALUE')));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(createJsonFileStore(file).toJsonSync()).toEqual({});
    expect(JSON.stringify(warning.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
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

  it.each(['.aionui-env', 'aionui-chat.txt', 'aionui-chat-message.txt', 'history.txt'])(
    'starts damaged %s without throwing',
    async (name) => {
      const target = path.join(directory, name);
      await fs.writeFile(target, '');
      const store = createJsonFileStore(target, { empty: () => (name === 'history.txt' ? [] : {}) });
      expect(store.toJsonSync()).toEqual(name === 'history.txt' ? [] : {});
      expect((await fs.readdir(directory)).some((entry) => entry.startsWith(name + '.corrupt-'))).toBe(true);
    }
  );

  it('leaves the primary present if restoring a valid backup is interrupted', async () => {
    await fs.writeFile(file, '');
    await fs.writeFile(`${file}.bak`, encode({ 'update.autoCheck': false }));
    const sync = await import('node:fs');
    const rename = sync.default.renameSync.bind(sync.default);
    const failure = vi.spyOn(sync.default, 'renameSync').mockImplementation((from, to) => {
      if (to === file) throw new Error('synthetic interrupted recovery');
      return rename(from, to);
    });
    expect(() => createJsonFileStore(file).toJsonSync()).toThrow('synthetic interrupted recovery');
    expect(await fs.readFile(file, 'utf8')).toBe('');
    failure.mockRestore();
    expect(createJsonFileStore(file).getSync('update.autoCheck')).toBe(false);
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
