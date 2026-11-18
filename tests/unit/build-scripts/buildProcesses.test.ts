import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { withBuildProcesses } from '../../../scripts/outbound-audit/bundles/buildProcesses.mjs';

const start = (ending = 'process.exit(0)') => {
  const child = childProcess.spawn(process.execPath, [
    '-e',
    `process.stdout.write('ready'); process.stdin.resume(); process.stdin.on('end', () => { ${ending} });`,
  ]);
  return child;
};

describe('audited build helper shutdown', () => {
  it('refuses success without observing the build service process', async () => {
    await expect(
      withBuildProcesses(
        () => 'built',
        () => {}
      )
    ).rejects.toThrow('Build or helper shutdown failed');
  });

  it('waits past stop resolution until the child exits and its streams close', async () => {
    const record = vi.fn();
    let child: ChildProcessWithoutNullStreams;
    let finished = false;
    const result = withBuildProcesses(
      async () => {
        child = start("setTimeout(() => { process.stderr.write('last'); process.exit(0); }, 100)");
        await once(child.stdout, 'data');
        return 'built';
      },
      () => child.stdin.end(),
      { record }
    ).then((value: string) => {
      finished = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finished).toBe(false);
    expect(await result).toBe('built');
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'passed', helpers: [{ exited: true, closed: true }] });
  });

  it('preserves a functional assertion failure while still retiring its helper', async () => {
    const failure = new Error('HTML worker assertion failed');
    const record = vi.fn();
    let child: ChildProcessWithoutNullStreams;
    const result = withBuildProcesses(
      async () => {
        child = start();
        await once(child.stdout, 'data');
        throw failure;
      },
      () => child.stdin.end(),
      { record }
    );
    await expect(result).rejects.toMatchObject({ errors: [failure] });
    expect(record.mock.calls[0][0]).toMatchObject({ status: 'failed', helpers: [{ exited: true, closed: true }] });
  });

  it('rejects a helper failure even when the build itself returned successfully', async () => {
    let child: ChildProcessWithoutNullStreams;
    await expect(
      withBuildProcesses(
        async () => {
          child = start('process.exit(7)');
          await once(child.stdout, 'data');
        },
        () => child.stdin.end()
      )
    ).rejects.toThrow('Build or helper shutdown failed');
  });

  it('fails a shutdown deadline and restores spawn instead of accepting a live helper', async () => {
    const spawn = childProcess.spawn;
    let child: ChildProcessWithoutNullStreams;
    const record = vi.fn();
    try {
      await expect(
        withBuildProcesses(
          async () => {
            child = start();
            await once(child.stdout, 'data');
          },
          () => {},
          { timeoutMs: 20, record }
        )
      ).rejects.toThrow('Build or helper shutdown failed');
      expect(record.mock.calls[0][0]).toMatchObject({ status: 'failed', helpers: [{ exited: false, closed: false }] });
      expect(childProcess.spawn).toBe(spawn);
    } finally {
      child!.stdin.end();
      await once(child!, 'close');
    }
  });

  it('preserves both build and stop errors', async () => {
    const build = new Error('build failed');
    const stop = new Error('stop failed');
    await expect(
      withBuildProcesses(
        () => {
          throw build;
        },
        () => {
          throw stop;
        }
      )
    ).rejects.toMatchObject({ errors: [build, stop] });
  });

  it('rejects overlapping observation without replacing the original owner', async () => {
    await expect(
      withBuildProcesses(
        () =>
          withBuildProcesses(
            () => {},
            () => {}
          ),
        () => {}
      )
    ).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'Overlapping build process observation' })],
    });
  });
});
