import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NATIVE_AUTH_HELPER } from './helperSource.js';
import { resolveNativeRuntime, type NativeRuntime } from './runtime.js';
import type { NativeAuthCommand, NativeAuthData, NativeAuthOperation, NativeAuthReply } from './types.js';

type Operation = {
  owner: string;
  state: NativeAuthOperation;
  child?: ChildProcessWithoutNullStreams;
  lastSeen: number;
};

const fail = (code: string): NativeAuthReply => ({ ok: false, code });
const ACTIONS = new Set(['catalog', 'setKey', 'logout', 'login', 'endpoint', 'select', 'poll', 'reply', 'cancel']);
const SAFE_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_CONFIG',
  'INVALID_ENDPOINT',
  'UNSUPPORTED',
  'UNSUPPORTED_PROVIDER',
  'UNSUPPORTED_MODEL',
  'EXCLUSIVE_REQUIRED',
  'PRIVATE_DIRECTORY_REQUIRED',
  'CONFLICT',
  'BUSY',
  'CANCELLED',
  'STALE_CHALLENGE',
  'NATIVE_FAILED',
]);

/** Owns sessionless helper processes only. It never attaches to a live ACP worker. */
export class NativeAuthService {
  private operation?: Operation;
  private mutating = false;
  private children = new Set<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly options: {
      runtime?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      loginTimeoutMs?: number;
    } = {}
  ) {}

  private runtime(): NativeRuntime | undefined {
    const explicit = this.options.runtime ?? process.env.AELIX_STUDIO_RUNTIME;
    if (explicit) return resolveNativeRuntime(explicit);
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [resources && path.join(resources, 'studio-preview'), path.resolve('.local/studio-preview')];
    for (const candidate of candidates) {
      if (candidate) {
        const runtime = resolveNativeRuntime(candidate);
        if (runtime) return runtime;
      }
    }
    return undefined;
  }

  /** Returns only safe error codes; request bodies/native exception text must not be logged. */
  async request(owner: string, input: unknown): Promise<NativeAuthReply> {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 60000)
        return fail('INVALID_INPUT');
      const command = input as NativeAuthCommand;
      if (!ACTIONS.has(command.action)) return fail('UNSUPPORTED');
      if ('operationId' in command) return this.control(owner, command);
      const runtime = this.runtime();
      if (!runtime) return fail('RUNTIME_UNAVAILABLE');
      const mutation = !['catalog', 'select'].includes(command.action);
      if (mutation && (this.mutating || this.operation?.state.phase === 'pending')) return fail('BUSY');
      if (mutation) this.mutating = true;
      if (command.action === 'login') {
        const operation: Operation = {
          owner,
          state: { operationId: randomUUID(), phase: 'pending' },
          lastSeen: Date.now(),
        };
        this.operation = operation;
        void this.run(runtime, command, operation).then((reply) => {
          operation.state = {
            operationId: operation.state.operationId,
            phase: operation.state.phase === 'cancelled' ? 'cancelled' : reply.ok ? 'complete' : 'failed',
            ...(reply.ok === false ? { code: reply.code } : {}),
          };
          this.mutating = false;
          const expiry = setTimeout(() => {
            if (this.operation === operation) this.operation = undefined;
          }, 60000);
          expiry.unref();
        });
        return { ok: true, data: { ...operation.state } };
      }
      try {
        const reply = await this.run(runtime, command);
        if (command.action === 'select' && reply.ok && 'root' in reply.data) {
          return {
            ok: true,
            data: {
              root: reply.data.root,
              command: 'node',
              args: [
                runtime.launcher,
                '--profile',
                'coding',
                `--provider=${command.provider}`,
                `--model=${command.model}`,
              ],
              env: [{ name: 'AELIX_CODING_AGENT_DIR', value: reply.data.root }],
            },
          };
        }
        return reply;
      } finally {
        if (mutation) this.mutating = false;
      }
    } catch {
      return fail('NATIVE_FAILED');
    }
  }

  private control(owner: string, command: Extract<NativeAuthCommand, { operationId: string }>): NativeAuthReply {
    const op = this.operation;
    if (!op || op.owner !== owner || op.state.operationId !== command.operationId) return fail('NOT_FOUND');
    op.lastSeen = Date.now();
    if (command.action === 'cancel' && op.state.phase === 'pending') {
      // No retry: a credential commit can race cancellation. The UI must refresh native status.
      op.state = { operationId: op.state.operationId, phase: 'cancelled' };
      op.child?.stdin.end();
      op.child?.kill('SIGTERM');
    } else if (command.action === 'reply') {
      if (
        op.state.phase !== 'pending' ||
        !op.state.prompt ||
        op.state.prompt.challengeId !== command.challengeId ||
        typeof command.value !== 'string' ||
        command.value.length > 16384
      )
        return fail('STALE_CHALLENGE');
      const prompt = op.state.prompt;
      if (
        (!command.value && !prompt.allowEmpty) ||
        (prompt.options && !prompt.options.some((option) => option.id === command.value))
      )
        return fail('INVALID_INPUT');
      op.child?.stdin.write(JSON.stringify({ challengeId: command.challengeId, value: command.value }) + '\n');
      delete op.state.prompt;
    }
    return { ok: true, data: { ...op.state } };
  }

  private run(runtime: NativeRuntime, command: NativeAuthCommand, operation?: Operation): Promise<NativeAuthReply> {
    return new Promise((resolve) => {
      const child = spawn(runtime.python, [...runtime.helperArgs, '-c', NATIVE_AUTH_HELPER], {
        env: { ...(this.options.env ?? process.env), PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      this.children.add(child);
      if (operation) operation.child = child;
      let buffer = '';
      let reply: NativeAuthReply | undefined;
      let timedOut = false;
      let stopping = false;
      const stop = (): void => {
        stopping = true;
        child.stdin.end();
        child.kill('SIGTERM');
      };
      const deadline = setTimeout(
        () => {
          timedOut = true;
          stop();
        },
        operation ? (this.options.loginTimeoutMs ?? 180000) : (this.options.timeoutMs ?? 20000)
      );
      const lease = operation
        ? setInterval(() => {
            if (Date.now() - operation.lastSeen > 30000) {
              timedOut = true;
              stop();
            }
          }, 5000)
        : undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      // Enforce shutdown even if native IO ignores SIGTERM. No descendant worker is spawned by this helper.
      const escalation = setInterval(() => {
        if ((stopping || operation?.state.phase === 'cancelled') && !killTimer) {
          killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        }
      }, 100);
      child.stdin.on('error', () => {});
      child.stderr.resume(); // Discard all native/provider diagnostics, never forward or capture.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stopping) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          reply = fail('FRAME_LIMIT');
          stop();
          return;
        }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.error) reply = fail(SAFE_CODES.has(frame.error) ? frame.error : 'NATIVE_FAILED');
            else if (frame.result) reply = { ok: true, data: frame.result as NativeAuthData };
            else if (operation?.state.phase === 'pending' && frame.event === 'authorization') {
              const url = new URL(frame.url);
              if (url.protocol !== 'https:' || url.username || url.password) {
                reply = fail('INVALID_ENDPOINT');
                stop();
                return;
              }
              operation.state.authorization = {
                url: url.toString(),
                ...(typeof frame.instructions === 'string' ? { instructions: frame.instructions.slice(0, 8192) } : {}),
              };
            } else if (operation?.state.phase === 'pending' && frame.event === 'prompt') {
              operation.state.prompt = {
                ...(frame.kind === 'manual' ? { kind: 'manual' as const } : {}),
                challengeId: frame.challengeId,
                message: frame.message,
                allowEmpty: frame.allowEmpty === true,
                ...(frame.options ? { options: frame.options } : {}),
              };
            }
          } catch {
            reply = fail('PROTOCOL_ERROR');
            stop();
          }
        }
      });
      const finish = (): void => {
        clearTimeout(deadline);
        clearInterval(escalation);
        if (lease) clearInterval(lease);
        if (killTimer) clearTimeout(killTimer);
        this.children.delete(child);
        resolve(timedOut ? fail('TIMEOUT') : (reply ?? fail('NATIVE_FAILED')));
      };
      child.once('error', () => {
        reply = fail('RUNTIME_UNAVAILABLE');
      });
      child.once('close', finish);
      child.stdin.write(JSON.stringify(command) + '\n');
      if (!operation) child.stdin.end();
    });
  }

  /** Cancel a caller's transient authorization when its window or WebUI host closes. */
  cancelOwner(owner: string, prefix = false): void {
    const operation = this.operation;
    if (operation && (prefix ? operation.owner.startsWith(owner) : operation.owner === owner)) {
      this.control(operation.owner, { action: 'cancel', operationId: operation.state.operationId });
    }
  }

  /** Dispose only processes owned by this service, including pending OAuth callback servers. */
  dispose(): void {
    for (const child of this.children) {
      child.stdin.end();
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (this.children.has(child)) child.kill('SIGKILL');
      }, 1000);
      timer.unref();
    }
    this.operation = undefined;
  }
}

let sharedService: NativeAuthService | undefined;
/** Desktop IPC and its WebUI facade share one mutation owner in this host process. */
export function getNativeAuthService(): NativeAuthService {
  return (sharedService ??= new NativeAuthService());
}
