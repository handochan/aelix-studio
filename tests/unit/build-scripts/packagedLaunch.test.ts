import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROCESS_NAMES = ['AionUi.exe', 'AionUi', 'electron.exe', 'electron'];

async function launch(platform: 'win32' | 'darwin' | 'linux', args: string[], unreadable = false) {
  vi.resetModules();
  const root = path.resolve('owned-launch-fixture');
  const out = path.join(root, 'out');
  const cwd = {
    win32: path.join(out, 'win-unpacked'),
    darwin: path.join(out, 'mac-arm64'),
    linux: path.join(out, 'linux-unpacked'),
  }[platform];
  const executable = {
    win32: path.join(cwd, 'AionUi.exe'),
    darwin: path.join(cwd, 'AionUi.app/Contents/MacOS/AionUi'),
    linux: path.join(cwd, 'aionui'),
  }[platform];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.fn();
  const kill = vi.fn();
  const spawn = vi.fn((_command: string, _args: string[] = []) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  });
  vi.doMock('node:fs', () => ({
    default: {
      existsSync: (file: string) => {
        if (unreadable) throw new Error('unreadable fixture output');
        return [out, cwd, executable].includes(file);
      },
      readdirSync: () => ['AionUi.app'],
    },
  }));
  vi.doMock('node:process', () => ({
    default: {
      platform,
      argv: ['node', 'packaged-launch.mjs', ...args],
      cwd: () => root,
      env: {},
      exit,
      kill,
    },
  }));
  vi.doMock('node:child_process', () => ({ spawn }));
  await import('../../../scripts/packaged-launch.mjs');
  if (unreadable && !args.includes('--help')) {
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  } else if (!args.includes('--dry-run') && !args.includes('--help')) {
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  }
  const kills = spawn.mock.calls.filter(([command]) => command === 'taskkill' || command === 'pkill');
  return { spawn, kills, kill, log, error, executable };
}

afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:process');
  vi.doUnmock('node:child_process');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe.each(['win32', 'darwin', 'linux'] as const)('packaged launch on %s', (platform) => {
  it('launches without terminating processes by default', async () => {
    const result = await launch(platform, []);
    expect(result.kills).toHaveLength(0);
    expect(result.spawn).toHaveBeenCalledWith(result.executable, [], expect.objectContaining({ shell: false }));
  });

  it('terminates the existing process-name targets only when clean is requested', async () => {
    const result = await launch(platform, ['--clean']);
    expect(result.kills.map(([, args]) => args)).toEqual(
      PROCESS_NAMES.map((name) => (platform === 'win32' ? ['/F', '/IM', name] : ['-f', name]))
    );
    expect(result.spawn.mock.calls.at(-1)?.[0]).toBe(result.executable);
  });

  it('prints the cleanup plan without spawning any process during a clean dry-run', async () => {
    const result = await launch(platform, ['--dry-run', '--clean']);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.kill).not.toHaveBeenCalled();
    expect(result.log).toHaveBeenCalledWith(`[packaged-launch] would terminate by name: ${PROCESS_NAMES.join(', ')}`);
  });

  it.each([['--no-clean'], ['--clean', '--no-clean']])('keeps legacy no-clean precedence for %j', async (...args) => {
    const result = await launch(platform, args);
    expect(result.kills).toHaveLength(0);
    expect(result.spawn).toHaveBeenCalledWith(result.executable, [], expect.objectContaining({ shell: false }));
  });

  it('documents the compatibility flag without requiring a packaged app', async () => {
    const result = await launch(platform, ['--help'], true);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.log).toHaveBeenCalledWith(expect.stringContaining('--no-clean  Compatibility flag'));
  });

  it('reports an unreadable output before attempting cleanup or launch', async () => {
    const result = await launch(platform, ['--clean'], true);
    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.error).toHaveBeenCalledWith(
      '[packaged-launch] Failed:',
      expect.objectContaining({ message: 'unreadable fixture output' })
    );
  });
});
