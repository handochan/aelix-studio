import { spawn } from 'node:child_process';

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
while (($id = [Console]::ReadLine()) -ne $null) {
  try {
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath,@{n='Birth';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().Ticks.ToString()}else{''}}})
    $value = @{id=$id;status='observed';rows=$rows}
  } catch { $value = @{id=$id;status='unavailable';reason='cim-query-error'} }
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 4 -Compress))
}
`;

/** Reuse one diagnostic-only CIM reader; cold startup never blocks a launch. */
export function createWindowsProcessReader({ spawnProcess = spawn, timeoutMs = 2000 } = {}) {
  let child, pending, busyId, timer;
  let sequence = 0;
  let stopped = false;
  let buffer = '';
  const settle = (value) => {
    clearTimeout(timer);
    const resolve = pending;
    pending = null;
    resolve?.(value);
  };
  const start = () => {
    child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) {
        buffer = '';
        settle({ status: 'unavailable', reason: 'cim-response-too-large' });
        return;
      }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).replace(/^\uFEFF/, '');
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (String(value.id) !== busyId) continue;
          busyId = null;
          settle(
            value.status === 'observed' && Array.isArray(value.rows)
              ? { status: 'observed', rows: value.rows }
              : { status: 'unavailable', reason: 'cim-query-error' }
          );
        } catch {
          // Progress/warning text is not evidence and never enters reports.
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      busyId = null;
      settle({ status: 'unavailable', reason: 'cim-worker-error' });
    });
    child.on('exit', () => {
      busyId = null;
      settle({ status: 'unavailable', reason: 'cim-worker-exited' });
    });
    child.stdin.on('error', () => settle({ status: 'unavailable', reason: 'cim-worker-input-error' }));
  };
  return {
    read() {
      if (stopped) return Promise.resolve({ status: 'unavailable', reason: 'cim-reader-stopped' });
      if (busyId) return Promise.resolve({ status: 'unavailable', reason: 'cim-query-pending' });
      return new Promise((resolve) => {
        pending = resolve;
        try {
          if (!child) start();
          busyId = String(++sequence);
          child.stdin.write(busyId + '\n');
          timer = setTimeout(() => settle({ status: 'unavailable', reason: 'cim-query-timeout' }), timeoutMs);
        } catch {
          busyId = null;
          settle({ status: 'unavailable', reason: 'cim-worker-error' });
        }
      });
    },
    stop() {
      stopped = true;
      settle({ status: 'unavailable', reason: 'cim-reader-stopped' });
      // This is the exact diagnostic child handle, never a product PID scan.
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}
