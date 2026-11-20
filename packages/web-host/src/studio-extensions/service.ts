import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FlowContext } from './flow/candidate.js';
import { baseEnvironment } from './flow/environment.js';
import { describe, mutate, reconcileBundle, rollback, type MutationRequest } from './flow/mutate.js';
import { parseOnlineSource } from './flow/onlineSource.js';
import { spawnChild, type Spawn } from './process.js';
import { locateLayout, resolveBundle } from './store/layout.js';
import {
  ExtensionFailure,
  type ExtensionCommand,
  type ExtensionFailureCode,
  type ExtensionOperation,
  type ExtensionReply,
  type ExtensionSource,
} from './types.js';

export type ExtensionServiceOptions = {
  /** The bundled Studio runtime: the directory holding `manifest.json`. */
  runtime: string;
  /** The helper's state directory in the Studio user data area (`<user data>/aelix-runtime`). */
  root: string;
  /** Environment the allow-list is applied to. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /** Read from Studio settings. False refuses name and git installs before any child starts. */
  onlineInstallEnabled?: boolean | (() => boolean);
  platform?: NodeJS.Platform;
  arch?: string;
  spawn?: Spawn;
  timeouts?: Partial<FlowContext['timeouts']>;
  /** Where the full text of an unexpected error goes. It is never part of a reply. */
  log?: (message: string, error: unknown) => void;
};

type Tracked = { owner: string; state: ExtensionOperation; abort: AbortController; done: Promise<void> };

const TIMEOUTS: FlowContext['timeouts'] = {
  lockMs: 30_000,
  environmentMs: 120_000,
  installerMs: 600_000,
  verifyMs: 120_000,
};
const ACTIONS = new Set(['list', 'install', 'update', 'remove', 'rollback', 'reconcile_bundle', 'poll', 'cancel']);
const FINISHED = new Set(['switched', 'failed', 'cancelled']);
const fail = (code: ExtensionFailureCode, detail?: string[]): ExtensionReply => ({
  ok: false,
  code,
  ...(detail && detail.length > 0 ? { detail } : {}),
});
const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value);

/** Validate source data before starting a change. */
function parseSource(value: unknown): ExtensionSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, path: file, folder } = value as { kind?: unknown; path?: unknown; folder?: unknown };
  if (kind !== 'file') return parseOnlineSource(value as Record<string, unknown>);
  if (!isPath(file)) return undefined;
  if (folder === undefined) return { kind, path: file };
  return isPath(folder) ? { kind, path: file, folder } : undefined;
}

const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 200;

/**
 * The Studio extension helper (Studio #32, D04 ADR 5.11): installs, updates, removes and
 * rolls back extensions in generations under the Studio user data directory.
 *
 * It starts the generation's own interpreter and the bundled one by argument vector and
 * never through a shell. It does not go through the host or ACP and never touches a
 * running conversation. Each adapter reads the current generation when it starts,
 * including when an existing conversation's adapter restarts.
 *
 * One change runs at a time. `install`, `update` and `remove` return an operation to
 * `poll`; `list` and `rollback` answer directly.
 *
 * On Windows every change is refused with `UNSUPPORTED_PLATFORM`; only `list` answers. The
 * helper has not run on Windows, and these are known not to be right there yet. They are the
 * work of the per-platform verification stage (1a'):
 * - cancelling a change stops native but not pip, its child, and the pipe handles pip
 *   inherited can keep the cancelled change and its lock waiting;
 * - console scripts are `.exe` launchers with the interpreter path of the generation they
 *   were installed in built in, so one carried over still points at the old generation;
 * - the lock (`msvcrt.locking`), the venv layout and the name of the null device as pip
 *   compares it are written from documentation and have never been exercised.
 */
export class ExtensionService {
  private operation?: Tracked;
  private direct?: { owner: string; abort: AbortController; done: Promise<ExtensionReply> };
  private changing = false;

  constructor(private readonly options: ExtensionServiceOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private async context(signal?: AbortSignal): Promise<FlowContext | undefined> {
    const bundle = await resolveBundle(this.options.runtime, this.platform, this.options.arch ?? process.arch);
    if (!bundle) return undefined;
    return {
      bundle,
      layout: await locateLayout(this.options.root),
      platform: this.platform,
      spawn: this.options.spawn ?? spawnChild,
      base: baseEnvironment(this.options.env ?? process.env, this.platform),
      timeouts: { ...TIMEOUTS, ...this.options.timeouts },
      signal,
    };
  }

  /** An unexpected error: its text may hold paths, so it goes to the log and the reply carries the code only. */
  private unexpected(error: unknown): ExtensionReply {
    (this.options.log ?? console.error)('[studio-extensions] unexpected error', error);
    return fail('INTERNAL');
  }

  /**
   * Handle one request. `owner` identifies the caller (a window or a signed-in WebUI user);
   * an operation can be polled and cancelled only by the owner that started it.
   */
  async request(owner: string, input: unknown): Promise<ExtensionReply> {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 20_000)
        return fail('INVALID_INPUT');
      const command = input as ExtensionCommand;
      if (!ACTIONS.has(command.action)) return fail('UNSUPPORTED');
      if (command.action === 'poll' || command.action === 'cancel') return this.control(owner, command);
      if (command.action === 'list') {
        const context = await this.context();
        return context ? { ok: true, data: await describe(context) } : fail('RUNTIME_UNAVAILABLE');
      }
      const direct = command.action === 'rollback' || command.action === 'reconcile_bundle';
      const change = direct ? undefined : parseChange(command);
      if (!direct && !change) return fail('INVALID_INPUT');
      if (change?.action === 'install' && change.source.kind !== 'file') {
        const enabled = this.options.onlineInstallEnabled;
        if ((typeof enabled === 'function' ? enabled() : enabled) === false) return fail('ONLINE_INSTALL_DISABLED');
      }
      if (this.platform === 'win32') return fail('UNSUPPORTED_PLATFORM');
      if (this.changing) return fail('BUSY');
      this.changing = true;
      if (!change) {
        const abort = new AbortController();
        const done = this.runDirect(command.action === 'reconcile_bundle', abort.signal);
        this.direct = { owner, abort, done };
        try {
          return await done;
        } finally {
          this.direct = undefined;
          this.changing = false;
        }
      }
      const abort = new AbortController();
      let context: FlowContext | undefined;
      try {
        context = await this.context(abort.signal);
      } finally {
        if (!context) this.changing = false;
      }
      if (!context) return fail('RUNTIME_UNAVAILABLE');
      const tracked: Tracked = {
        owner,
        state: { operationId: randomUUID(), action: change.action, phase: 'checking' },
        abort,
        done: Promise.resolve(),
      };
      this.operation = tracked;
      tracked.done = this.run(tracked, change, context);
      return { ok: true, data: { ...tracked.state } };
    } catch (error) {
      return error instanceof ExtensionFailure ? fail(error.code, error.detail) : this.unexpected(error);
    }
  }

  private async runDirect(reconcile: boolean, signal: AbortSignal): Promise<ExtensionReply> {
    try {
      const context = await this.context(signal);
      if (!context) return fail('RUNTIME_UNAVAILABLE');
      const data = reconcile ? await reconcileBundle(context) : await rollback(context);
      return { ok: true, data };
    } catch (error) {
      return error instanceof ExtensionFailure ? fail(error.code, error.detail) : this.unexpected(error);
    }
  }

  private control(owner: string, command: Extract<ExtensionCommand, { operationId: string }>): ExtensionReply {
    const tracked = this.operation;
    if (!tracked || tracked.owner !== owner || tracked.state.operationId !== command.operationId)
      return fail('NOT_FOUND');
    // A change that already switched stays switched; cancelling stops one that has not.
    if (command.action === 'cancel' && !FINISHED.has(tracked.state.phase)) tracked.abort.abort();
    return { ok: true, data: { ...tracked.state } };
  }

  private async run(tracked: Tracked, change: MutationRequest, context: FlowContext): Promise<void> {
    const finish = (code: ExtensionFailureCode, detail: string[], output?: string): void => {
      tracked.state = {
        operationId: tracked.state.operationId,
        action: tracked.state.action,
        phase: code === 'CANCELLED' ? 'cancelled' : 'failed',
        code,
        ...(detail.length > 0 ? { detail } : {}),
        ...(output ? { output } : {}),
      };
    };
    try {
      const outcome = await mutate(context, change, {
        progress: (phase) => {
          tracked.state = { ...tracked.state, phase };
        },
        suffix: () => randomBytes(2).toString('hex'),
        now: () => new Date(),
      });
      tracked.state = { ...tracked.state, phase: 'switched', generation: outcome.generation };
    } catch (error) {
      if (error instanceof ExtensionFailure) finish(error.code, error.detail, error.output);
      else {
        this.unexpected(error);
        finish('INTERNAL', []);
      }
    } finally {
      this.changing = false;
    }
  }

  /** Cancel a caller's running change when its window or WebUI session closes. */
  cancelOwner(owner: string, prefix = false): void {
    for (const tracked of [this.operation, this.direct])
      if (tracked && (prefix ? tracked.owner.startsWith(owner) : tracked.owner === owner)) tracked.abort.abort();
  }

  /**
   * Stop a running change. Its candidate is removed; the current generation is untouched.
   * The promise resolves once the change has ended and nothing of it is running any more.
   */
  async dispose(): Promise<void> {
    this.operation?.abort.abort();
    this.direct?.abort.abort();
    await Promise.all([this.operation?.done, this.direct?.done]);
  }
}

function parseChange(command: ExtensionCommand): MutationRequest | undefined {
  if (command.action === 'remove') return isName(command.name) ? { action: 'remove', name: command.name } : undefined;
  if (command.action !== 'install' && command.action !== 'update') return undefined;
  const source = parseSource(command.source);
  if (!source) return undefined;
  if (command.action === 'install') {
    const { replaceIncompatible } = command;
    return replaceIncompatible === undefined || typeof replaceIncompatible === 'boolean'
      ? { action: 'install', source, replaceIncompatible }
      : undefined;
  }
  return source.kind === 'file' && isName(command.name) ? { action: 'update', name: command.name, source } : undefined;
}
