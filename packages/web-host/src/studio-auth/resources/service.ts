import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeStudioAgentDir, selectNativeRuntime, type NativeRuntime } from '../runtime.js';
import { NATIVE_RESOURCES_HELPER } from './helperSource.js';
import {
  type NativeResourcesCommand,
  type NativeResourcesReply,
  type PageRequest,
  type ResourceKind,
} from './types.js';

const REQUEST_BYTES = 60000;
const RESPONSE_BYTES = 256 * 1024;
const CATALOG_BYTES = 16 * 1024 * 1024;
const CURSOR_TTL = 60000;
const RECEIPT_TTL = 600000;
const RECEIPT_CAPACITY = 256;
const MAX_HELPERS = 4;
const RUNTIME_METADATA_BYTES = 1024 * 1024;
const SNAPSHOT_BUDGET = 32 * 1024 * 1024;
const KINDS = new Set(['tool', 'skill', 'mcp']);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type List = Extract<NativeResourcesCommand, { action: 'profiles/list' | 'selections/list' }>;
type Receipt = { digest: string; expires: number; reply: Promise<NativeResourcesReply> };
type Snapshot = {
  context: string;
  store: string;
  column: 'profiles' | 'items';
  header: Record<string, unknown>;
  rows: { value: Record<string, unknown>; bytes: number }[];
  bytes: number;
  limit: number;
  expires: number;
  cursors: Map<number, string>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)
  );
}

/** Rebuild allowlisted commands so the same write has the same digest across wire encodings. */
function parse(input: unknown): NativeResourcesCommand | 'SCOPE_DENIED' | undefined {
  if (!record(input)) return;
  const keys = (...allowed: string[]) => Object.keys(input).every((key) => allowed.includes(key));
  const { action, cursor, limit, kind, scope, name, changes, expectedRevision, requestId } = input;
  if (action === 'profiles/show') {
    if (keys('action', 'name') && bounded(name, 256) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
      return { action, name };
    return;
  }
  if (action !== 'profiles/list' && action !== 'selections/list' && action !== 'selections/set') return;
  if (action !== 'profiles/list') {
    if (scope === 'project') return 'SCOPE_DENIED';
    if (scope !== 'global' || typeof kind !== 'string' || !KINDS.has(kind)) return;
  }
  if (action === 'selections/set') {
    if (
      !keys('action', 'scope', 'kind', 'changes', 'expectedRevision', 'requestId') ||
      !bounded(expectedRevision, 256) ||
      typeof requestId !== 'string' ||
      !UUID_V7.test(requestId) ||
      !Array.isArray(changes) ||
      changes.length < 1 ||
      changes.length > 1024
    )
      return;
    const edits: { key: string; on: boolean }[] = [];
    const seen = new Set<string>();
    for (const change of changes) {
      if (
        !record(change) ||
        Object.keys(change).length !== 2 ||
        !bounded(change.key, REQUEST_BYTES) ||
        typeof change.on !== 'boolean' ||
        seen.has(change.key)
      )
        return;
      seen.add(change.key);
      edits.push({ key: change.key, on: change.on });
    }
    return {
      action,
      scope: 'global',
      kind: kind as ResourceKind,
      changes: edits,
      expectedRevision,
      requestId: requestId.toLowerCase(),
    };
  }
  if (!keys('action', 'limit', 'cursor', ...(action === 'selections/list' ? ['scope', 'kind'] : []))) return;
  if ('cursor' in input && ('limit' in input || !bounded(cursor, 256))) return;
  if ('limit' in input && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) return;
  const page: PageRequest = typeof cursor === 'string' ? { cursor } : typeof limit === 'number' ? { limit } : {};
  return action === 'profiles/list'
    ? { action, ...page }
    : { action, scope: 'global', kind: kind as ResourceKind, ...page };
}

function canonical(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonical(parent), path.basename(file));
  }
}

function runtimeIdentity(file: string): string {
  try {
    const info = statSync(file, { bigint: true });
    return [canonical(file), info.dev, info.ino, info.mtimeNs].join(':');
  } catch {
    return file;
  }
}

function runtimeFile(file: string): Buffer {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    const { size } = info;
    if (!info.isFile() || size > RUNTIME_METADATA_BYTES) throw new Error('Invalid runtime metadata');
    const buffer = Buffer.allocUnsafe(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytes = readSync(fd, buffer, length, buffer.length - length, null);
      if (bytes === 0) break;
      length += bytes;
    }
    if (length !== size) throw new Error('Runtime metadata changed while being read');
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function selectResourceRuntime(explicit = process.env.AELIX_STUDIO_RUNTIME): NativeRuntime | undefined {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const roots = explicit
    ? [explicit]
    : [...(resources ? [path.join(resources, 'studio-preview')] : []), '.local/studio-preview'];
  for (const root of roots) {
    // The shared native selector reads a bundled manifest. Refuse special or
    // oversized files before delegating to that selector.
    try {
      const info = statSync(path.resolve(root, 'manifest.json'));
      if (!info.isFile() || info.size > RUNTIME_METADATA_BYTES) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    const selected = selectNativeRuntime(root);
    if (selected) return selected;
  }
}

/** The install recipe and launchers advance the binding even if Python is reused. */
function runtimeGeneration(runtime: NativeRuntime): string | undefined {
  const digest = (file: string) => createHash('sha256').update(runtimeFile(file)).digest('hex');
  const metadata = path.join(runtime.root, runtime.acpArgs ? 'manifest.json' : 'receipt.json');
  try {
    const install = runtimeIdentity(path.dirname(runtime.python));
    const launcher = digest(runtime.launcher);
    const entry = runtime.acpArgs?.at(-2);
    const entryDigest = entry ? digest(entry) : undefined;
    let seal: Buffer;
    try {
      seal = runtimeFile(metadata);
    } catch (error) {
      if (entry || (error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      // Developer venvs have no build receipt. Bind their selected launcher and install directory.
      return JSON.stringify([install, launcher]);
    }
    const manifest: unknown = JSON.parse(seal.toString('utf8'));
    if (!record(manifest) || manifest.target !== `${process.platform}-${process.arch}`) return;
    if (entry) {
      const recipe = manifest.recipeSha256;
      if (
        manifest.schema !== 'aelix.studio-preview.runtime/1' ||
        !record(recipe) ||
        recipe['launch.cjs'] !== launcher ||
        recipe['launch.py'] !== entryDigest
      )
        return;
    } else if (manifest.launcherSha256 !== launcher) {
      return;
    }
    return JSON.stringify([install, createHash('sha256').update(seal).digest('hex'), launcher, entryDigest]);
  } catch {
    return;
  }
}

function launchEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
  const env = { ...source, AELIX_CODING_AGENT_DIR: root } as NodeJS.ProcessEnv;
  for (const key of ['AELIX_SETTINGS_PATH', 'AELIX_MCP_CONFIG', 'AELIX_AUTH_PATH', 'XDG_CONFIG_HOME'] as const) {
    const configured = env[key];
    if (!configured) continue;
    env[key] =
      key === 'AELIX_MCP_CONFIG' && (configured === '~' || configured.startsWith('~/'))
        ? path.resolve(env.HOME || env.USERPROFILE || homedir(), configured.slice(2))
        : path.resolve(configured);
  }
  return env;
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const unknownOutcome = (): NativeResourcesReply => ({ ok: false, code: 'OUTCOME_UNKNOWN', retryable: false });

function readReply(line: string, command: NativeResourcesCommand): NativeResourcesReply | undefined {
  const value: unknown = JSON.parse(line);
  if (!record(value)) return;
  if (value.ok === true && record(value.data)) {
    if (
      command.action === 'selections/set' &&
      (!bounded(value.data.revision, 256) ||
        value.data.saved !== true ||
        !Array.isArray(value.data.changed) ||
        !Array.isArray(value.data.mismatches))
    )
      return;
    return { ok: true, data: value.data };
  }
  if (value.ok !== false) return;
  switch (value.code) {
    case 'REVISION_CONFLICT':
      if (bounded(value.currentRevision, 256))
        return { ok: false, code: value.code, currentRevision: value.currentRevision };
      return;
    case 'SELECTION_MISSING':
    case 'SELECTION_LOCKED':
      if (command.action === 'selections/set' && command.changes.some(({ key }) => key === value.key))
        return { ok: false, code: value.code, key: value.key as string };
      return;
    case 'OUTCOME_UNKNOWN':
      return unknownOutcome();
    case 'PROFILE_UNAVAILABLE':
    case 'SCOPE_READONLY':
    case 'STORE_UNREADABLE':
    case 'BUSY':
    case 'HELPER_UNAVAILABLE':
    case 'RESULT_TOO_LARGE':
    case 'SAVE_FAILED':
      return { ok: false, code: value.code };
  }
}

/** Owns sessionless stdio invocations, immutable cursors and write receipts for both transports. */
export class NativeResourcesService {
  private readonly secret = randomBytes(32);
  private readonly receipts = new Map<string, Receipt>();
  private readonly snapshots = new Set<Snapshot>();
  private readonly cursors = new Map<string, { snapshot: Snapshot; offset: number }>();
  private readonly children = new Set<ReturnType<typeof spawn>>();
  private readonly generations = new Map<string, number>();
  private active = 0;
  private disposed = false;

  constructor(private readonly options: { runtime?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {}

  async request(owner: string, input: unknown): Promise<NativeResourcesReply> {
    if (this.disposed) return { ok: false, code: 'HELPER_UNAVAILABLE' };
    let admitted: ReturnType<typeof parse>;
    try {
      if (bytesOf(input ?? null) > REQUEST_BYTES) return { ok: false, code: 'FRAME_LIMIT' };
      admitted = parse(input);
    } catch {
      admitted = undefined;
    }
    if (admitted === 'SCOPE_DENIED') return { ok: false, code: admitted };
    if (!admitted) return { ok: false, code: 'INVALID_INPUT' };
    const command = admitted;
    const now = Date.now();
    for (const [id, receipt] of this.receipts) if (receipt.expires <= now) this.receipts.delete(id);
    for (const snapshot of this.snapshots) if (snapshot.expires <= now) this.clearSnapshot(snapshot);

    const mutation = command.action === 'selections/set';
    const id = mutation ? JSON.stringify([owner, command.requestId]) : '';
    const digest = mutation ? createHash('sha256').update(JSON.stringify(command)).digest('hex') : '';
    if (mutation) {
      const prior = this.receipts.get(id);
      if (prior) return prior.digest === digest ? prior.reply : { ok: false, code: 'REQUEST_ID_CONFLICT' };
      if (this.receipts.size >= RECEIPT_CAPACITY) return { ok: false, code: 'DEDUP_CAPACITY' };
    }

    const list = command.action === 'profiles/list' || command.action === 'selections/list';
    if (!(list && command.cursor) && this.active >= MAX_HELPERS) return { ok: false, code: 'BUSY' };
    const runtime = selectResourceRuntime(this.options.runtime);
    const runtimeSeal = runtime && runtimeGeneration(runtime);
    if (!runtime || !runtimeSeal) {
      return { ok: false, code: list && command.cursor ? 'CURSOR_STALE' : 'RUNTIME_UNAVAILABLE' };
    }
    const root = normalizeStudioAgentDir(this.options.env);
    const env = launchEnvironment(this.options.env ?? process.env, root);
    const filter = 'kind' in command ? command.kind : 'profiles';
    const configured =
      filter === 'profiles'
        ? root
        : filter === 'mcp'
          ? env.AELIX_MCP_CONFIG || path.join(root, 'mcp.json')
          : env.AELIX_SETTINGS_PATH || path.join(root, 'settings.json');
    const store = JSON.stringify([
      filter === 'tool' || filter === 'skill' ? 'settings' : filter,
      canonical(configured),
    ]);
    const context = JSON.stringify([
      owner,
      filter,
      store,
      canonical(root),
      configured,
      canonical(runtime.root),
      runtimeIdentity(runtime.python),
      runtimeSeal,
    ]);
    if (list && command.cursor) {
      const cursor = this.cursors.get(command.cursor);
      if (cursor?.snapshot.context !== context) return { ok: false, code: 'CURSOR_STALE' };
      return this.page(cursor.snapshot, cursor.offset);
    }

    const seed = createHmac('sha256', this.secret).update(context).digest('hex');
    const generation = this.generations.get(store) ?? 0;
    this.active++;
    const pending = this.run(runtime, runtimeSeal, { ...env, STUDIO_RESOURCES_REVISION_KEY: seed }, command)
      .then((reply): NativeResourcesReply => {
        if (list && reply.ok) {
          if (runtimeGeneration(runtime) !== runtimeSeal) return { ok: false, code: 'CURSOR_STALE' };
          return this.firstPage(command, context, store, reply.data, generation);
        }
        if (
          mutation &&
          ((reply.ok && reply.data.revision !== command.expectedRevision) ||
            (reply.ok === false && ['REVISION_CONFLICT', 'OUTCOME_UNKNOWN'].includes(reply.code)))
        ) {
          this.generations.set(store, (this.generations.get(store) ?? 0) + 1);
          for (const snapshot of this.snapshots) {
            if (snapshot.store === store) this.clearSnapshot(snapshot);
          }
        }
        if (bytesOf(reply) <= RESPONSE_BYTES) return reply;
        return mutation ? unknownOutcome() : { ok: false, code: 'RESULT_TOO_LARGE' };
      })
      .finally(() => {
        this.active--;
      });
    if (mutation) {
      const receipt = { digest, expires: Infinity, reply: pending };
      this.receipts.set(id, receipt);
      void pending.then(() => {
        receipt.expires = Date.now() + RECEIPT_TTL;
      });
    }
    return pending;
  }

  private clearSnapshot(snapshot: Snapshot): void {
    this.snapshots.delete(snapshot);
    for (const cursor of snapshot.cursors.values()) this.cursors.delete(cursor);
  }

  private firstPage(
    command: List,
    context: string,
    store: string,
    data: Record<string, unknown>,
    generation: number
  ): NativeResourcesReply {
    const column = command.action === 'profiles/list' ? 'profiles' : 'items';
    const { [column]: raw, nextCursor: _cursor, ...header } = data;
    if (!Array.isArray(raw)) return { ok: false, code: 'HELPER_UNAVAILABLE' };
    const keys = new Set<string>();
    const rows: { key: Buffer; value: Record<string, unknown>; bytes: number }[] = [];
    for (const value of raw) {
      if (!record(value)) return { ok: false, code: 'HELPER_UNAVAILABLE' };
      const key = column === 'profiles' && record(value.ref) ? value.ref.name : value.key;
      if (typeof key !== 'string' || keys.has(key)) return { ok: false, code: 'HELPER_UNAVAILABLE' };
      keys.add(key);
      rows.push({ key: Buffer.from(key), value, bytes: bytesOf(value) });
    }
    rows.sort((a, b) => Buffer.compare(a.key, b.key));
    const snapshot: Snapshot = {
      context,
      store,
      column,
      header,
      rows,
      bytes: bytesOf(data),
      limit: command.limit ?? 40,
      expires: Date.now() + CURSOR_TTL,
      cursors: new Map(),
    };
    const reply = this.page(snapshot, 0);
    if (reply.ok && reply.data.nextCursor !== null) {
      if (this.disposed || generation !== (this.generations.get(store) ?? 0)) {
        this.clearSnapshot(snapshot);
        return { ok: false, code: 'CURSOR_STALE' };
      }
      let occupied = 0;
      for (const active of this.snapshots) occupied += active.bytes;
      if (occupied + snapshot.bytes > SNAPSHOT_BUDGET) {
        this.clearSnapshot(snapshot);
        return { ok: false, code: 'BUSY' };
      }
      this.snapshots.add(snapshot);
    }
    return reply;
  }

  private page(snapshot: Snapshot, offset: number): NativeResourcesReply {
    const { header, column, rows, limit } = snapshot;
    const items: Record<string, unknown>[] = [];
    const reply = { ok: true as const, data: { ...header, [column]: items, nextCursor: null as string | null } };
    const base = bytesOf(reply);
    const cursorSize = 24 + 2; // 18 random bytes as base64url in JSON quotes.
    let extra = 0;
    let index = offset;
    for (; index < Math.min(rows.length, offset + limit); index++) {
      const row = rows[index];
      const next = extra + row.bytes + (items.length ? 1 : 0);
      if (base + next + (index + 1 < rows.length ? cursorSize - 4 : 0) > RESPONSE_BYTES) break;
      items.push(row.value);
      extra = next;
    }
    if (base > RESPONSE_BYTES || (index === offset && offset < rows.length))
      return { ok: false, code: 'RESULT_TOO_LARGE' };
    if (index < rows.length) {
      let cursor = snapshot.cursors.get(index);
      if (!cursor) {
        cursor = randomBytes(18).toString('base64url');
        snapshot.cursors.set(index, cursor);
        this.cursors.set(cursor, { snapshot, offset: index });
      }
      reply.data.nextCursor = cursor;
    }
    return reply;
  }

  private async run(
    runtime: NativeRuntime,
    seal: string,
    env: NodeJS.ProcessEnv,
    command: NativeResourcesCommand
  ): Promise<NativeResourcesReply> {
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(path.join(tmpdir(), 'studio-native-resources-'));
      if (this.disposed) return { ok: false, code: 'HELPER_UNAVAILABLE' };
      if (runtimeGeneration(runtime) !== seal) return { ok: false, code: 'RUNTIME_UNAVAILABLE' };
      return await this.invoke(runtime, cwd, env, command);
    } catch {
      return { ok: false, code: 'HELPER_UNAVAILABLE' };
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  private invoke(
    runtime: NativeRuntime,
    cwd: string,
    env: NodeJS.ProcessEnv,
    command: NativeResourcesCommand
  ): Promise<NativeResourcesReply> {
    return new Promise((resolve) => {
      const child = spawn(runtime.python, [...runtime.helperArgs, '-c', NATIVE_RESOURCES_HELPER], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      });
      this.children.add(child);
      let dispatched = false;
      let interrupted = false;
      const chunks: Buffer[] = [];
      let size = 0;
      const failure = () =>
        command.action === 'selections/set' && dispatched
          ? unknownOutcome()
          : { ok: false as const, code: 'HELPER_UNAVAILABLE' as const };
      const deadline = setTimeout(() => {
        interrupted = true;
        child.kill('SIGKILL');
      }, this.options.timeoutMs ?? 40000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= CATALOG_BYTES) chunks.push(chunk);
        else child.kill('SIGKILL');
      });
      child.on('error', () => {
        interrupted = true;
      });
      child.stdin.on('error', () => {
        interrupted = true;
      });
      child.once('spawn', () => {
        dispatched = true;
        child.stdin.end(JSON.stringify(command) + '\n');
      });
      child.once('close', (code) => {
        clearTimeout(deadline);
        this.children.delete(child);
        if (size > CATALOG_BYTES && command.action !== 'selections/set') {
          resolve({ ok: false, code: 'RESULT_TOO_LARGE' });
          return;
        }
        if (!interrupted && code === 0 && size <= CATALOG_BYTES) {
          try {
            const frame = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            if (frame.endsWith('\n') && frame.indexOf('\n') === frame.length - 1) {
              resolve(readReply(frame, command) ?? failure());
              return;
            }
          } catch {
            // A malformed or incomplete response does not establish the write outcome.
          }
        }
        resolve(failure());
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill('SIGKILL');
    for (const snapshot of this.snapshots) this.clearSnapshot(snapshot);
    this.receipts.clear();
    this.generations.clear();
  }
}

let sharedService: NativeResourcesService | undefined;
export function getNativeResourcesService(): NativeResourcesService {
  return (sharedService ??= new NativeResourcesService());
}
