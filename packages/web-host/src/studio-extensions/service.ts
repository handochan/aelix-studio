import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FlowContext } from './flow/candidate.js';
import { baseEnvironment } from './flow/environment.js';
import { describe, mutate, rollback, type MutationRequest } from './flow/mutate.js';
import { spawnChild, type Spawn } from './process.js';
import { layoutOf, resolveBundle } from './store/layout.js';
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
  platform?: NodeJS.Platform;
  arch?: string;
  spawn?: Spawn;
  timeouts?: Partial<FlowContext['timeouts']>;
};

type Tracked = { owner: string; state: ExtensionOperation; abort: AbortController };

const TIMEOUTS: FlowContext['timeouts'] = {
  lockMs: 30_000,
  environmentMs: 120_000,
  installerMs: 600_000,
  verifyMs: 120_000,
};
const ACTIONS = new Set(['list', 'install', 'update', 'remove', 'rollback', 'poll', 'cancel']);
const FINISHED = new Set(['switched', 'failed', 'cancelled']);
const fail = (code: ExtensionFailureCode, detail?: string[]): ExtensionReply => ({
  ok: false,
  code,
  ...(detail && detail.length > 0 ? { detail } : {}),
});
const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value);

/** Accept only a file source with absolute paths; anything else is not a request this helper takes. */
function parseSource(value: unknown): ExtensionSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, path: file, folder } = value as { kind?: unknown; path?: unknown; folder?: unknown };
  if (kind !== 'file' || !isPath(file)) return undefined;
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
 * running conversation: a change applies to conversations started afterwards.
 *
 * One change runs at a time. `install`, `update` and `remove` return an operation to
 * `poll`; `list` and `rollback` answer directly.
 */
export class ExtensionService {
  private operation?: Tracked;
  private changing = false;

  constructor(private readonly options: ExtensionServiceOptions) {}

  private async context(signal?: AbortSignal): Promise<FlowContext | undefined> {
    const platform = this.options.platform ?? process.platform;
    const bundle = await resolveBundle(this.options.runtime, platform, this.options.arch ?? process.arch);
    if (!bundle) return undefined;
    return {
      bundle,
      layout: layoutOf(path.resolve(this.options.root)),
      platform,
      spawn: this.options.spawn ?? spawnChild,
      base: baseEnvironment(this.options.env ?? process.env, platform),
      timeouts: { ...TIMEOUTS, ...this.options.timeouts },
      signal,
    };
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
      const change = command.action === 'rollback' ? undefined : parseChange(command);
      if (command.action !== 'rollback' && !change) return fail('INVALID_INPUT');
      if (this.changing) return fail('BUSY');
      this.changing = true;
      if (!change) {
        try {
          const context = await this.context();
          return context ? { ok: true, data: await rollback(context) } : fail('RUNTIME_UNAVAILABLE');
        } finally {
          this.changing = false;
        }
      }
      const abort = new AbortController();
      const context = await this.context(abort.signal).catch((): undefined => undefined);
      if (!context) {
        this.changing = false;
        return fail('RUNTIME_UNAVAILABLE');
      }
      const tracked: Tracked = {
        owner,
        state: { operationId: randomUUID(), action: change.action, phase: 'checking' },
        abort,
      };
      this.operation = tracked;
      void this.run(tracked, change, context);
      return { ok: true, data: { ...tracked.state } };
    } catch (error) {
      return error instanceof ExtensionFailure ? fail(error.code, error.detail) : fail('INTERNAL');
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
      else finish('INTERNAL', [error instanceof Error ? error.message : 'unexpected error']);
    } finally {
      this.changing = false;
    }
  }

  /** Cancel a caller's running change when its window or WebUI session closes. */
  cancelOwner(owner: string, prefix = false): void {
    const tracked = this.operation;
    if (tracked && (prefix ? tracked.owner.startsWith(owner) : tracked.owner === owner)) tracked.abort.abort();
  }

  /** Stop a running change. Its candidate is removed; the current generation is untouched. */
  dispose(): void {
    this.operation?.abort.abort();
  }
}

function parseChange(command: ExtensionCommand): MutationRequest | undefined {
  if (command.action === 'remove') return isName(command.name) ? { action: 'remove', name: command.name } : undefined;
  if (command.action !== 'install' && command.action !== 'update') return undefined;
  const source = parseSource(command.source);
  if (!source) return undefined;
  if (command.action === 'install') return { action: 'install', source };
  return isName(command.name) ? { action: 'update', name: command.name, source } : undefined;
}
