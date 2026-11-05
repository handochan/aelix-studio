import { describe, expect, it, vi } from 'vitest';
import type { App } from 'electron';
import { configureBackgroundNetworking } from '@/process/startup/backgroundNetworking';

describe('Chromium background network policy', () => {
  it('configures engine defaults before ready and retains the OS DNS policy after ready', () => {
    const appendSwitch = vi.fn();
    const configureHostResolver = vi.fn();
    const on = vi.fn();
    configureBackgroundNetworking({
      commandLine: { appendSwitch } as unknown as App['commandLine'],
      on,
      configureHostResolver,
    });
    expect(appendSwitch.mock.calls).toEqual([
      ['disable-background-networking'],
      ['disable-component-update'],
      ['disable-domain-reliability'],
    ]);
    expect(configureHostResolver).not.toHaveBeenCalled();
    on.mock.calls[0][1]();
    expect(configureHostResolver).toHaveBeenCalledWith({ enableBuiltInResolver: false, secureDnsMode: 'off' });
  });
  it('does not suppress an engine configuration failure', () => {
    expect(() =>
      configureBackgroundNetworking({
        commandLine: {
          appendSwitch: () => {
            throw new Error('engine unavailable');
          },
        } as unknown as App['commandLine'],
        on: vi.fn(),
        configureHostResolver: vi.fn(),
      })
    ).toThrow('engine unavailable');
  });
});
