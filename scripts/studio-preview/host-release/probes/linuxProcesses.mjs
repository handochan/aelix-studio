import fs from 'node:fs';

/** Batch small proc reads without per-file libuv/eventfd notifications. */
export function createLinuxProcessReader({ sandbox, classify, io = fs } = {}) {
  const cache = new Map();
  return {
    read({ roots = new Map(), known = new Map(), refresh = false } = {}) {
      try {
        const pids = io.readdirSync('/proc').filter((pid) => /^\d+$/.test(pid));
        const present = new Set(pids.map(Number));
        for (const pid of cache.keys()) if (!present.has(pid)) cache.delete(pid);
        const rows = pids.flatMap((pid) => {
          try {
            const text = io.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const end = text.lastIndexOf(')');
            const fields = text.slice(end + 2).split(/\s+/);
            if (!/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1])) throw new Error('invalid proc stat');
            return [
              {
                pid: Number(pid),
                parentPid: Number(fields[1]),
                birth: fields[19],
                comm: text.slice(text.indexOf('(') + 1, end),
                state: fields[0] === 'Z' ? 'zombie' : 'live',
              },
            ];
          } catch (error) {
            return error.code === 'ENOENT' ? [] : [{ pid: Number(pid), unavailable: true }];
          }
        });
        const owned = new Set();
        for (const row of rows) {
          const root = roots.get(row.pid);
          const previous = known.get(row.pid);
          const cached = cache.get(row.pid);
          if (
            !row.unavailable &&
            ((root?.active && (!root.birth || root.birth === row.birth)) ||
              previous?.birth === row.birth ||
              (cached?.birth === row.birth && cached.sandboxMatched))
          )
            owned.add(row.pid);
        }
        for (;;) {
          const more = rows.filter((row) => owned.has(row.parentPid) && !owned.has(row.pid));
          if (!more.length) break;
          for (const row of more) owned.add(row.pid);
        }
        return {
          status: 'observed',
          rows: rows.map((row) => {
            if (row.unavailable) return row;
            const cached = cache.get(row.pid);
            let metadata = cached;
            // Owned actors can exec another Python role without changing PID or
            // start ticks. Reclassify them; do not freeze their first argv shape.
            if (refresh || !cached || cached.birth !== row.birth || cached.comm !== row.comm || owned.has(row.pid)) {
              try {
                const argv = io.readFileSync(`/proc/${row.pid}/cmdline`, 'utf8');
                const executable = argv.split('\0', 1)[0];
                const command = argv.replaceAll('\0', ' ');
                metadata = {
                  birth: row.birth,
                  comm: row.comm,
                  role: classify(command, executable),
                  sandboxMatched: Boolean(sandbox && command.includes(sandbox)),
                };
                cache.set(row.pid, metadata);
              } catch {
                metadata = cached?.birth === row.birth ? cached : { role: 'other', sandboxMatched: false };
              }
            }
            return {
              pid: row.pid,
              parentPid: row.parentPid,
              birth: row.birth,
              birthSource: 'proc-start-ticks',
              state: row.state,
              role: metadata.role,
              sandboxMatched: metadata.sandboxMatched,
            };
          }),
        };
      } catch {
        return { status: 'unavailable', reason: 'snapshot-read-error', rows: [] };
      }
    },
  };
}
