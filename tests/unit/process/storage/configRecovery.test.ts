import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { on: vi.fn(), quit: vi.fn() } }));
import { createJsonFileStore } from '@/process/storage/jsonFile';
import { createConfigRecovery } from '@/process/storage/configRecovery';

let directory: string;
let file: string;
const encode = (data: unknown) => btoa(encodeURIComponent(JSON.stringify(data)));
function profile() {
  const recovery = createConfigRecovery(file);
  const store = createJsonFileStore(file, {
    empty: () => (recovery.active() ? { 'update.autoCheck': false } : {}),
    onReset: (preserved) => recovery.mark(preserved),
  });
  return { recovery, store };
}
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-recovery-'));
  file = path.join(directory, 'aionui-config.txt');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('configuration recovery mode', () => {
  it.each(['', btoa('%7B')])('starts damaged %j offline and preserves the original bytes', async (raw) => {
    await fs.writeFile(file, raw);
    const { recovery, store } = profile();
    expect(recovery.autoCheck(store.getSync('update.autoCheck'))).toBe(false);
    const preserved = (await fs.readdir(directory)).find((name) => name.startsWith('aionui-config.txt.corrupt-'))!;
    expect(await fs.readFile(path.join(directory, preserved), 'utf8')).toBe(raw);
    expect(profile().recovery.autoCheck(profile().store.getSync('update.autoCheck'))).toBe(false);
  });

  it.each(['clear', 'setJson'] as const)(
    'retains update suppression through %s and the next startup',
    async (method) => {
      await fs.writeFile(file, '');
      const { recovery, store } = profile();
      store.toJsonSync();
      if (method === 'clear') await store.clear();
      else await store.setJson({});
      expect(recovery.autoCheck(await store.get('update.autoCheck'))).toBe(false);
      const next = profile();
      expect(next.recovery.autoCheck(next.store.getSync('update.autoCheck'))).toBe(false);
    }
  );

  it('follows a value explicitly saved by the settings screen', async () => {
    await fs.writeFile(file, '');
    const { recovery, store } = profile();
    await store.set('update.autoCheck', true);
    expect(recovery.autoCheck(await store.get('update.autoCheck'))).toBe(false);
    await recovery.finish();
    expect(recovery.autoCheck(await store.get('update.autoCheck'))).toBe(true);
  });

  it('keeps normal fresh and manually deleted profiles default-on', async () => {
    await fs.writeFile(`${file}.bak`, encode({ 'update.autoCheck': false }));
    const { recovery, store } = profile();
    expect(recovery.autoCheck(store.getSync('update.autoCheck'))).toBe(true);
    expect(recovery.active()).toBe(false);
  });

  it('also suppresses updates when resetting env loses the custom config location', async () => {
    const recovery = createConfigRecovery(file);
    const env = path.join(directory, '.aionui-env');
    await fs.writeFile(env, '');
    const store = createJsonFileStore(env, { onReset: (preserved) => recovery.mark(preserved) });
    expect(store.getSync('aionui.dir')).toBeUndefined();
    await fs.writeFile(file, encode({ 'update.autoCheck': true }));
    expect(recovery.autoCheck(createJsonFileStore(file).getSync('update.autoCheck'))).toBe(false);
  });

  it('acknowledges the notice once without re-enabling updates', async () => {
    const { recovery } = profile();
    recovery.mark('synthetic.corrupt');
    const show = vi.fn().mockResolvedValue(undefined);
    await Promise.all([recovery.showNotice(show), recovery.showNotice(show)]);
    await createConfigRecovery(file).showNotice(show);
    expect(show).toHaveBeenCalledTimes(1);
    expect(recovery.autoCheck(true)).toBe(false);
  });

  it('does not recreate suppression after a user choice races notice acknowledgement', async () => {
    const { recovery } = profile();
    recovery.mark('synthetic.corrupt');
    let dismiss: (() => void) | undefined;
    const showing = recovery.showNotice(
      () =>
        new Promise<void>((resolve) => {
          dismiss = resolve;
        })
    );
    await recovery.finish();
    dismiss?.();
    await showing;
    expect(recovery.active()).toBe(false);
  });

  it('fails closed on an unreadable marker and still displays the notice', async () => {
    await fs.writeFile(`${file}.recovery.json`, 'null');
    const { recovery } = profile();
    const show = vi.fn().mockResolvedValue(undefined);
    await recovery.showNotice(show);
    expect(show).toHaveBeenCalledOnce();
    expect(recovery.autoCheck(true)).toBe(false);
  });

  it('does not treat a marker read error as permission to check for updates', async () => {
    await fs.mkdir(`${file}.recovery.json`);
    expect(profile().recovery.autoCheck(true)).toBe(false);
  });

  it('cancels an open notice on quit without recording a user acknowledgement', async () => {
    const { recovery } = profile();
    recovery.mark('synthetic.corrupt');
    const showing = recovery.showNotice(
      (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    );
    recovery.cancelNotice();
    await showing;
    const showAgain = vi.fn().mockResolvedValue(undefined);
    await createConfigRecovery(file).showNotice(showAgain);
    expect(showAgain).toHaveBeenCalledOnce();
    expect(recovery.autoCheck(true)).toBe(false);
  });
});
