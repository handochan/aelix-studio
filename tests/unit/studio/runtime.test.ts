import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStudioCommand, bootstrapStudioRuntime } from '@/process/studio/runtime';

afterEach(() => vi.unstubAllGlobals());

describe('Studio runtime resolution', () => {
  it('passes Windows paths through the managed Node bridge without a shell', () => {
    expect(getStudioCommand('C:\\Aelix Studio 한글\\resources', 'win32', 'x64')).toEqual({
      command: 'node',
      args: ['C:\\Aelix Studio 한글\\resources\\bundled-aelix\\win32-x64\\launch.cjs', 'acp'],
    });
  });

  it('resolves the same bridge layout on POSIX', () => {
    expect(getStudioCommand('/Studio resources', 'linux', 'arm64').args[0]).toBe(
      '/Studio resources/bundled-aelix/linux-arm64/launch.cjs'
    );
  });

  it('rejects a missing bundle before contacting the backend', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(bootstrapStudioRuntime(25808, '/does-not-exist/studio-runtime', '/data')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
