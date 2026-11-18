import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWindowsProcessReader } from '../../../scripts/studio-preview/host-release/probes/windowsProcesses.mjs';
import { processSnapshot } from '../../../scripts/studio-preview/host-release/probes/processTimeline.mjs';

afterEach(() => vi.useRealTimers());

function worker() {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    unref: vi.fn(),
    kill: vi.fn(),
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
  });
}

describe('persistent diagnostic CIM reader', () => {
  it('retains the two second observation bound, then reuses the warmed child after a cold timeout', async () => {
    vi.useFakeTimers();
    const child = worker();
    const spawnProcess = vi.fn().mockReturnValue(child);
    const reader = createWindowsProcessReader({ spawnProcess });
    try {
      const cold = reader.read();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await cold).toEqual({ status: 'unavailable', reason: 'cim-query-timeout' });
      expect(await reader.read()).toMatchObject({ reason: 'cim-query-pending' });
      child.stdout.emit('data', '{"id":"1","status":"observed","rows":[]}\n');
      const warm = reader.read();
      child.stdout.emit('data', '\uFEFF{"id":"2","status":"observed","rows":[]}\n');
      expect(await warm).toEqual({ status: 'observed', rows: [] });
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      reader.stop();
    }
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('does not serialize worker stderr or arbitrary failures into diagnostics', async () => {
    const child = worker();
    const reader = createWindowsProcessReader({ spawnProcess: () => child });
    try {
      const pending = reader.read();
      child.stderr.emit('data', '/Users/PRIVATE token=PRIVATE');
      child.emit('error', new Error('PRIVATE'));
      expect(await pending).toEqual({ status: 'unavailable', reason: 'cim-worker-error' });
    } finally {
      reader.stop();
    }
  });

  it('keeps executable paths and command lines private after CIM classification', async () => {
    const reader = {
      read: async () => ({
        status: 'observed',
        rows: [
          {
            ProcessId: 1,
            ParentProcessId: 0,
            Birth: '1234',
            ExecutablePath: 'C:\\Users\\PRIVATE path\\aelix-studio-host.exe',
            CommandLine: 'PRIVATE',
          },
        ],
      }),
      stop: vi.fn(),
    };
    const snapshot = await processSnapshot('PRIVATE', 'win32', reader);
    expect(snapshot.rows[0]).toMatchObject({ pid: 1, birth: '1234', role: 'host' });
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(reader.stop).not.toHaveBeenCalled();
  });

  it('stops only its own worker without another observation or product process signal', async () => {
    const child = worker();
    const reader = createWindowsProcessReader({ spawnProcess: () => child });
    const pending = reader.read();
    reader.stop();
    expect(await pending).toMatchObject({ reason: 'cim-reader-stopped' });
    expect(await reader.read()).toMatchObject({ reason: 'cim-reader-stopped' });
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith();
  });
});
