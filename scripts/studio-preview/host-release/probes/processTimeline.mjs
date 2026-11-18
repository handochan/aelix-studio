import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWindowsProcessReader } from './windowsProcesses.mjs';
import { createLinuxProcessReader } from './linuxProcesses.mjs';

const run = promisify(execFile);
const ROLES = new Set(['main', 'host', 'acp', 'native-wrapper', 'native']);
const UNAVAILABLE = new Set([
  'snapshot-read-error',
  'snapshot-unavailable',
  'cim-query-error',
  'cim-query-timeout',
  'cim-query-pending',
  'cim-worker-error',
  'cim-worker-exited',
  'cim-worker-input-error',
  'cim-response-too-large',
  'cim-reader-stopped',
]);

/** Classify only fixed fixture/runtime roles; command lines remain private. */
export function processRole(command, executablePath) {
  const executable = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const name = (executablePath ?? executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? '').split(/[\\/]/).at(-1);
  if (/^aelix-studio-host(?:\.exe)?$/i.test(name)) return 'host';
  // ACP arguments also name its native wrapper. Classify the first invoked
  // fixture script, rather than a later --aelix-arg or extension argument.
  const script = /(?:^|[\\/\s"'])(native-wrapper\.py|launch\.py)(?=[\s"']|$)["']?(?:\s+(acp|native)(?=\s|$))?/.exec(
    command
  );
  if (script?.[1] === 'native-wrapper.py') return 'native-wrapper';
  if (script?.[2] === 'acp') return 'acp';
  if (script?.[2] === 'native') return 'native';
  return 'other';
}

/** Read process identities asynchronously; no product signal, exit wait, or instrumentation. */
export async function processSnapshot(sandbox, platform = process.platform, windowsReader, linuxReader, linuxScope) {
  try {
    let rows;
    if (platform === 'linux') {
      return (linuxReader ?? createLinuxProcessReader({ sandbox, classify: processRole })).read(linuxScope);
    } else if (platform === 'win32') {
      const reader = windowsReader ?? createWindowsProcessReader();
      let value;
      try {
        value = await reader.read();
      } finally {
        if (!windowsReader) reader.stop();
      }
      if (value.status !== 'observed') return { ...value, rows: [] };
      rows = value.rows.map((row) => ({
        pid: row.ProcessId,
        parentPid: row.ParentProcessId,
        birth: String(row.Birth ?? ''),
        command: row.CommandLine ?? '',
        executablePath: row.ExecutablePath || undefined,
        state: 'unknown',
      }));
    } else {
      const [{ stdout }, { stdout: commands }] = await Promise.all([
        run('ps', ['-axo', 'pid=,ppid=,lstart=,stat=,args='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }),
        run('ps', ['-axo', 'pid=,comm='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }),
      ]);
      const executables = new Map(
        commands.split('\n').flatMap((line) => {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          return match ? [[Number(match[1]), match[2].trim()]] : [];
        })
      );
      rows = stdout
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(\S+)\s+(.*)$/.exec(line);
          if (!match) throw new Error('incomplete process snapshot');
          return {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            birth: match[3].replace(/\s+/g, ' '),
            command: match[5],
            executablePath: executables.get(Number(match[1])),
            state: match[4][0] === 'Z' ? 'zombie' : 'live',
          };
        });
    }
    // Only candidate descendants are exported by the tracker. Do not retain
    // executable names, paths, argv, environment or arbitrary OS error text.
    rows = rows
      .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0)
      .map((row) => ({
        ...row,
        role: processRole(row.command, row.executablePath),
        sandboxMatched: Boolean(sandbox && row.command.includes(sandbox)),
      }));
    return {
      status: 'observed',
      rows: rows
        .filter((row) => !row.gone)
        .map(({ command: _command, executablePath: _executablePath, gone: _gone, ...row }) => row),
    };
  } catch {
    return { status: 'unavailable', reason: 'snapshot-read-error', rows: [] };
  }
}

/** Reconcile sampled process generations; absence is an observed bound, not an exact OS exit time. */
export function createProcessTimeline({
  sandbox,
  record = () => {},
  snapshot,
  intervalMs = 1000,
  publishIntervalMs = 5000,
} = {}) {
  const roots = new Map();
  const entries = new Map();
  const windowsReader = process.platform === 'win32' && !snapshot ? createWindowsProcessReader() : null;
  const linuxReader =
    process.platform === 'linux' && !snapshot ? createLinuxProcessReader({ sandbox, classify: processRole }) : null;
  let timer, pending;
  let stopped = false;
  let sampleCount = 0;
  let unavailableSamples = 0;
  const unavailableReasons = {};
  let phase = 'before-launch';
  let launch = null;
  let droppedProcesses = 0;
  let refresh = true;
  let forcePublish = true;
  let lastPublished = -Infinity;
  const changed = new Set();
  const publish = (at = new Date().toISOString(), unavailableReason, checkpoint = false) => {
    if (!changed.size && !checkpoint && !unavailableReason && performance.now() - lastPublished < publishIntervalMs)
      return;
    const event =
      changed.size || checkpoint || unavailableReason
        ? {
            kind: 'process-timeline-delta',
            schema: 'aelix.launch-process-timeline/1',
            observedAt: at,
            phase,
            launch,
            checkpoint,
            sampleCount,
            unavailableSamples,
            ...(unavailableReason ? { unavailableReason } : {}),
            processes: [...entries.values()]
              .filter((entry) => changed.has(entry.id))
              .map((entry) => ({ ...entry, parentChanges: [...entry.parentChanges] })),
          }
        : null;
    try {
      record(
        {
          schema: 'aelix.launch-process-timeline/1',
          intervalMs,
          publishIntervalMs,
          sampleCount,
          unavailableSamples,
          unavailableReasons: { ...unavailableReasons },
          droppedProcesses,
          exitTimeMeaning: 'first-observed-absent-or-zombie; lower-bound=lastLiveSampleStartedAt-or-unknown',
          processes: [...entries.values()].map((entry) => ({ ...entry, parentChanges: [...entry.parentChanges] })),
        },
        event
      );
      changed.clear();
      lastPublished = performance.now();
    } catch {
      /* diagnostics cannot alter the smoke */
    }
  };
  const observe = (value, at = new Date().toISOString(), context) => {
    if (!context) {
      context = { phase, launch, startedAt: at, checkpoint: forcePublish };
      forcePublish = false;
    }
    sampleCount++;
    if (value.status !== 'observed') {
      unavailableSamples++;
      const reason = UNAVAILABLE.has(value.reason) ? value.reason : 'snapshot-unavailable';
      unavailableReasons[reason] = (unavailableReasons[reason] ?? 0) + 1;
      publish(at, reason, context.checkpoint);
      return;
    }
    const rows = new Map(value.rows.map((row) => [row.pid, row]));
    const active = new Map(
      [...entries.values()].filter((entry) => !entry.exitObservedAt).map((entry) => [entry.pid, entry])
    );
    const selected = new Set();
    for (const row of rows.values()) {
      const root = roots.get(row.pid);
      const old = active.get(row.pid)?.birth === row.birth;
      if (row.sandboxMatched || (root?.active && (!root.birth || root.birth === row.birth)) || old)
        selected.add(row.pid);
      if (root?.active && selected.has(row.pid) && !root.birth && !row.unavailable) root.birth = row.birth;
    }
    for (;;) {
      const more = [...rows.values()].filter((row) => selected.has(row.parentPid) && !selected.has(row.pid));
      if (!more.length) break;
      for (const row of more) selected.add(row.pid);
    }
    for (const pid of selected) {
      const row = rows.get(pid);
      if (row.unavailable) continue;
      const root = roots.get(pid);
      const key = `${pid}:${row.birth}`;
      const previous = entries.get(key);
      const role = root?.birth === row.birth ? 'main' : ROLES.has(row.role) ? row.role : previous?.role;
      if (!ROLES.has(role) || !row.birth) continue;
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= 512) {
          droppedProcesses++;
          continue;
        }
        let owner = row,
          ownerLaunch = null;
        const seen = new Set();
        while (owner && !seen.has(owner.pid)) {
          seen.add(owner.pid);
          const parentRoot = roots.get(owner.pid);
          if (parentRoot?.birth === owner.birth) {
            ownerLaunch = parentRoot.launch;
            break;
          }
          owner = rows.get(owner.parentPid);
        }
        entry = {
          id: entries.size + 1,
          pid,
          parentPid: row.parentPid,
          initialParentPid: row.parentPid,
          birth: row.birth,
          birthSource: row.birthSource ?? (process.platform === 'win32' ? 'cim-creation-ticks' : 'ps-lstart-second'),
          role,
          roleEvidence: role === 'main' ? 'main-process-handle' : 'fixture-argv-shape',
          launch: ownerLaunch,
          firstSeenAt: at,
          lastSeenAt: at,
          lastLiveSampleStartedAt: null,
          exitObservedAt: null,
          parentChanges: [],
        };
        entries.set(key, entry);
        changed.add(entry.id);
      }
      if (entry.parentPid !== row.parentPid) {
        changed.add(entry.id);
        entry.parentChanges.push({ observedAt: at, parentPid: row.parentPid });
        entry.parentPid = row.parentPid;
      }
      entry.lastSeenAt = at;
      if (entry.lastRole !== row.role || entry.state !== row.state) changed.add(entry.id);
      entry.sampleStartedAt = context.startedAt;
      entry.sampleCompletedAt = at;
      entry.lastRole = row.role;
      entry.state = row.state;
      entry.phaseAtStart = context.phase;
      entry.phaseAtCompletion = phase;
      entry.launchAtStart = context.launch;
      entry.launchAtCompletion = launch;
      if (row.state === 'live') entry.lastLiveSampleStartedAt = context.startedAt;
      if (row.state === 'zombie' && !entry.exitObservedAt) {
        Object.assign(entry, { exitObservedAt: at, exitObservation: 'zombie' });
        changed.add(entry.id);
      }
    }
    for (const entry of entries.values()) {
      if (entry.exitObservedAt) continue;
      const row = rows.get(entry.pid);
      if (row?.unavailable) continue;
      if (!row || row.birth !== entry.birth) {
        Object.assign(entry, { exitObservedAt: at, exitObservation: row ? 'pid-reused' : 'absent' });
        changed.add(entry.id);
      }
    }
    publish(at, undefined, context.checkpoint);
  };
  const sample = () => {
    if (pending || stopped) return;
    const context = { phase, launch, startedAt: new Date().toISOString(), refresh, checkpoint: forcePublish };
    refresh = false;
    forcePublish = false;
    pending = Promise.resolve()
      .then(
        snapshot ??
          (() =>
            processSnapshot(sandbox, process.platform, windowsReader, linuxReader, {
              roots,
              known: new Map(
                [...entries.values()].filter((entry) => !entry.exitObservedAt).map((entry) => [entry.pid, entry])
              ),
              refresh: context.refresh,
            }))
      )
      .then((value) => {
        if (!(stopped && value.reason === 'cim-reader-stopped')) observe(value, new Date().toISOString(), context);
      })
      .catch(() => observe({ status: 'unavailable' }, new Date().toISOString(), context))
      .finally(() => {
        pending = null;
        if (refresh && !stopped) sample();
      });
  };
  return {
    observe,
    addMain(pid, number) {
      roots.set(pid, { active: true, birth: null, launch: number });
      refresh = true;
      forcePublish = true;
      sample();
    },
    mainExit(pid) {
      const root = roots.get(pid);
      if (root) root.active = false;
      refresh = true;
      forcePublish = true;
      sample();
    },
    checkpoint(nextPhase, number) {
      phase = nextPhase;
      launch = number;
      refresh = true;
      forcePublish = true;
      sample();
    },
    start() {
      timer = setInterval(sample, intervalMs);
      timer.unref();
      sample();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      windowsReader?.stop();
      forcePublish = false;
      publish(new Date().toISOString(), undefined, true);
    },
  };
}
