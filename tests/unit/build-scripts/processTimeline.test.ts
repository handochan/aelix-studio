import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProcessTimeline,
  processRole,
  processSnapshot,
} from '../../../scripts/studio-preview/host-release/probes/processTimeline.mjs';

afterEach(() => vi.useRealTimers());

const row = (pid: number, parentPid: number, role: string, birth = String(pid)) => ({
  pid,
  parentPid,
  role,
  birth,
  sandboxMatched: false,
  state: 'live',
});

describe('owned process observation', () => {
  it('retains host ACP wrapper native lineage across reparenting and observes exit bounds', () => {
    const record = vi.fn();
    const timeline = createProcessTimeline({ record, snapshot: async () => ({ status: 'unavailable' }) });
    timeline.addMain(10, 1);
    timeline.observe(
      {
        status: 'observed',
        rows: [
          row(10, 1, 'other'),
          row(11, 10, 'host'),
          row(12, 11, 'acp'),
          row(13, 12, 'native-wrapper'),
          row(14, 13, 'native'),
          row(99, 1, 'host'),
        ],
      },
      'time-1'
    );
    timeline.mainExit(10);
    timeline.checkpoint('before-launch', 2);
    timeline.observe({ status: 'observed', rows: [row(13, 2, 'native-wrapper'), row(14, 13, 'native')] }, 'time-2');
    timeline.observe({ status: 'observed', rows: [] }, 'time-3');
    const value = record.mock.calls.at(-1)?.[0];
    expect(value.processes.map((entry: { pid: number }) => entry.pid)).toEqual([10, 11, 12, 13, 14]);
    expect(value.processes[3]).toMatchObject({
      launch: 1,
      initialParentPid: 12,
      parentPid: 2,
      lastSeenAt: 'time-2',
      exitObservedAt: 'time-3',
      parentChanges: [{ observedAt: 'time-2', parentPid: 2 }],
    });
    expect(value.processes[4]).toMatchObject({ role: 'native', launch: 1, exitObservedAt: 'time-3' });
    timeline.stop();
  });

  it('does not invent exits on failed snapshots or attribute a reused PID to the old launch', () => {
    const record = vi.fn();
    const timeline = createProcessTimeline({ record });
    timeline.addMain(10, 1);
    timeline.observe({ status: 'observed', rows: [row(10, 1, 'other'), row(11, 10, 'host')] }, 'first');
    timeline.observe({ status: 'unavailable', rows: [] }, 'unavailable');
    expect(record.mock.calls.at(-1)?.[0].processes[1].exitObservedAt).toBeNull();
    timeline.mainExit(10);
    timeline.observe({ status: 'observed', rows: [row(11, 1, 'host', 'different-birth')] }, 'reused');
    expect(record.mock.calls.at(-1)?.[0].processes).toHaveLength(2);
    expect(record.mock.calls.at(-1)?.[0].processes[1]).toMatchObject({
      exitObservedAt: 'reused',
      exitObservation: 'pid-reused',
    });
    timeline.stop();
  });

  it('exports only fixed roles and metadata rather than private paths and argv', () => {
    expect(processRole('"C:\\Users\\PRIVATE\\launch.py" acp --token=PRIVATE')).toBe('acp');
    expect(processRole('/Users/PRIVATE/native-wrapper.py --secret PRIVATE')).toBe('native-wrapper');
    expect(processRole('/owned/python -I /owned/launch.py acp --aelix-arg=/owned/native-wrapper.py')).toBe('acp');
    expect(processRole('/owned/python /owned/native-wrapper.py --arg=/owned/launch.py native')).toBe('native-wrapper');
    expect(
      processRole('/private/owned path/aelix-studio-host --port 123', '/private/owned path/aelix-studio-host')
    ).toBe('host');
    const record = vi.fn();
    const timeline = createProcessTimeline({ record });
    timeline.observe({
      status: 'observed',
      rows: [{ ...row(1, 0, 'native'), sandboxMatched: true, command: 'PRIVATE' }],
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('PRIVATE');
    timeline.stop();
  });

  it('observes a known native generation becoming a zombie after its cmdline is gone', () => {
    const record = vi.fn();
    const timeline = createProcessTimeline({ record });
    timeline.observe({ status: 'observed', rows: [{ ...row(14, 13, 'native'), sandboxMatched: true }] }, 'live');
    timeline.observe({ status: 'observed', rows: [{ ...row(14, 1, 'other'), state: 'zombie' }] }, 'dead');
    expect(record.mock.calls.at(-1)?.[0].processes[0]).toMatchObject({
      role: 'native',
      lastRole: 'other',
      lastLiveSampleStartedAt: 'live',
      exitObservedAt: 'dead',
      exitObservation: 'zombie',
    });
    timeline.stop();
  });

  it('does not invent a live lower bound for a process first seen as a zombie', () => {
    const record = vi.fn();
    const timeline = createProcessTimeline({ record });
    timeline.observe(
      { status: 'observed', rows: [{ ...row(14, 13, 'native'), sandboxMatched: true, state: 'zombie' }] },
      'dead'
    );
    expect(record.mock.calls.at(-1)?.[0].processes[0]).toMatchObject({
      lastLiveSampleStartedAt: null,
      exitObservedAt: 'dead',
    });
    timeline.stop();
  });

  it('retains capture start and completion phases when an asynchronous sample spans launches', async () => {
    vi.useFakeTimers();
    const record = vi.fn();
    let complete: (value: object) => void;
    const timeline = createProcessTimeline({
      record,
      snapshot: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    timeline.checkpoint('before-launch', 1);
    await vi.advanceTimersByTimeAsync(0);
    timeline.checkpoint('cleanup-complete', 2);
    complete!({ status: 'observed', rows: [{ ...row(14, 13, 'native'), sandboxMatched: true }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(record.mock.calls.at(-1)?.[0].processes[0]).toMatchObject({
      phaseAtStart: 'before-launch',
      phaseAtCompletion: 'cleanup-complete',
      launchAtStart: 1,
      launchAtCompletion: 2,
    });
    timeline.stop();
  });

  it('uses a non-overlapping passive sampler and never waits for process exit', async () => {
    vi.useFakeTimers();
    const snapshot = vi.fn().mockResolvedValue({ status: 'observed', rows: [] });
    const timeline = createProcessTimeline({ snapshot, intervalMs: 1000 });
    timeline.start();
    await vi.advanceTimersByTimeAsync(2100);
    expect(snapshot).toHaveBeenCalledTimes(3);
    timeline.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('does not return raw command lines from a real process table', async () => {
    const value = await processSnapshot('PRIVATE_NONMATCHING_ROOT');
    if (value.status === 'observed') expect(value.rows.every((entry: object) => !('command' in entry))).toBe(true);
    else expect(value).toEqual({ status: 'unavailable', rows: [] });
  });
});
