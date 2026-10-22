import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStudioCommand, bootstrapStudioRuntime } from '@/process/studio/runtime';

afterEach(() => vi.unstubAllGlobals());

describe('Studio runtime resolution', () => {
  it('resolves a Windows executable without a shell or a command string', () => {
    expect(getStudioCommand('C:\\Aelix Studio 한글\\resources', 'win32', 'x64')).toEqual({
      command: 'C:\\Aelix Studio 한글\\resources\\bundled-aelix\\win32-x64\\python\\python.exe',
      args: ['-I', 'C:\\Aelix Studio 한글\\resources\\bundled-aelix\\win32-x64\\launch.py', 'acp'],
    });
  });

  it('uses isolated bundled Python on POSIX too', () => {
    expect(getStudioCommand('/Studio resources', 'linux', 'arm64').command).toBe(
      '/Studio resources/bundled-aelix/linux-arm64/python/bin/python3'
    );
  });

  it('rejects a missing bundle before contacting the backend', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(bootstrapStudioRuntime(25808, '/does-not-exist/studio-runtime', '/data')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
