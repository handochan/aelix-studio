import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FlowContext } from './flow/candidate.js';
import { baseEnvironment } from './flow/environment.js';
import {
  clearProxyCredentials,
  describe,
  mutate,
  reconcileBundle,
  rollback,
  saveSettings,
  setDefault,
  setProxyCredentials,
  type MutationRequest,
} from './flow/mutate.js';
import { privateGitEnvironment } from './flow/online/credentials.js';
import {
  hasSavedCredentials,
  MEMORY_ONLY_VAULT,
  parseProxyCredentials,
  type ProxyCredentialVault,
} from './flow/online/proxy/credentials.js';
import { parseSettingsChange, readSettings, type SettingsChange, type StoredSettings } from './flow/online/settings.js';
import { parseOnlineSource } from './flow/online/source.js';
import { spawnChild, windowsChildSpawn, type Spawn } from './process.js';
import { locateLayout, resolveBundle, verifyLayout } from './store/layout.js';
import { isManagedId } from './launch/managedCatalog.js';
import {
  ExtensionFailure,
  type ExtensionCommand,
  type ExtensionFailureCode,
  type ExtensionOperation,
  type ExtensionReply,
  type ExtensionSettingsState,
  type ExtensionSource,
  type ProxyCredentials,
} from './types.js';

export type ExtensionServiceOptions = {
  /** The bundled Studio runtime: the directory holding `manifest.json`. */
  runtime: string;
  /** The helper's state directory in the Studio user data area (`<user data>/aelix-runtime`). */
  root: string;
  /** Environment the allow-list is applied to. Defaults to this process's. */
  env?: NodeJS.ProcessEnv;
  /**
   * A Studio-level policy above the user's extension settings: false refuses name and git
   * installs before any child starts, whatever `settings.onlineInstall` says. Leave it out to
   * let the stored setting decide.
   */
  onlineInstallEnabled?: boolean | (() => boolean);
  platform?: NodeJS.Platform;
  arch?: string;
  spawn?: Spawn;
  timeouts?: Partial<FlowContext['timeouts']>;
  /** Where the full text of an unexpected error goes. It is never part of a reply. */
  log?: (message: string, error: unknown) => void;
  /**
   * Where proxy credentials can be kept. The desktop host passes its `safeStorage` vault
   * (keychain, or memory-only where the OS has no secret store); left out, as in the
   * standalone WebUI, nothing is kept and each online install brings its credentials.
   */
  proxyVault?: ProxyCredentialVault;
};

type Tracked = { owner: string; state: ExtensionOperation; abort: AbortController; done: Promise<void> };

const TIMEOUTS: FlowContext['timeouts'] = {
  lockMs: 30_000,
  environmentMs: 120_000,
  installerMs: 600_000,
  verifyMs: 120_000,
};
type DirectCommand =
  | Extract<ExtensionCommand, { action: 'rollback' | 'reconcile_bundle' | 'set_default' | 'clear_proxy_credentials' }>
  | { action: 'set_settings'; change: SettingsChange }
  | { action: 'set_proxy_credentials'; credentials: ProxyCredentials };
const ACTIONS = new Set([
  'list',
  'get_settings',
  'set_settings',
  'set_proxy_credentials',
  'clear_proxy_credentials',
  'install',
  'update',
  'remove',
  'set_default',
  'rollback',
  'reconcile_bundle',
  'poll',
  'cancel',
]);
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
 * `poll`; `list`, `rollback`, `set_default`, `get_settings`, `set_settings` and the proxy
 * credential requests answer directly.
 * Saving settings is a change too: it waits for the lock and answers `BUSY` while another
 * change runs. A running install keeps the settings it started with.
 *
 * Windows runs the installer subprocess tree in a job so cancellation cannot strand
 * pip. Git sources still require a qualified Windows Git/SSH toolchain.
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
      spawn:
        this.options.spawn ??
        (this.platform === 'win32' ? windowsChildSpawn(bundle.python, bundle.launcher) : spawnChild),
      base: baseEnvironment(this.options.env ?? process.env, this.platform),
      timeouts: { ...TIMEOUTS, ...this.options.timeouts },
      signal,
      user: privateGitEnvironment(this.options.env ?? process.env, this.platform),
      proxyVault: this.vault,
    };
  }

  private get vault(): ProxyCredentialVault {
    return this.options.proxyVault ?? MEMORY_ONLY_VAULT;
  }

  /** False when Studio's own policy turns online installs off, whatever the user's setting says. */
  private onlineAllowed(): boolean {
    const enabled = this.options.onlineInstallEnabled;
    return (typeof enabled === 'function' ? enabled() : enabled) !== false;
  }

  /** What a screen sees of the settings: never the credentials, never their id. */
  private async settingsState(stored: StoredSettings): Promise<ExtensionSettingsState> {
    const layout = await locateLayout(this.options.root);
    return {
      settings: stored.settings,
      unreadable: stored.unreadable,
      onlineInstallLocked: !this.onlineAllowed(),
      credentialMode: this.vault.mode,
      hasSavedCredentials: await hasSavedCredentials(layout, this.vault, stored.settings.proxy, stored.credentialId),
    };
  }

  /** The stored settings, read without the lock and without creating anything. */
  private async storedSettings(): Promise<StoredSettings> {
    const layout = await locateLayout(this.options.root);
    await verifyLayout(layout);
    return readSettings(layout);
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
      if (command.action === 'get_settings')
        return { ok: true, data: await this.settingsState(await this.storedSettings()) };
      if (
        command.action === 'rollback' ||
        command.action === 'reconcile_bundle' ||
        command.action === 'set_default' ||
        command.action === 'set_settings' ||
        command.action === 'set_proxy_credentials' ||
        command.action === 'clear_proxy_credentials'
      ) {
        if (
          command.action === 'set_default' &&
          (!isManagedId(command.extensionId) || typeof command.enabled !== 'boolean')
        )
          return fail('INVALID_INPUT');
        if (command.action === 'set_proxy_credentials' && this.vault.mode !== 'keychain')
          return fail('PROXY_CREDENTIALS_NOT_STORED');
        // Checked before anything waits or is written; a refused proxy or credential is never echoed.
        const direct: DirectCommand =
          command.action === 'set_settings'
            ? { action: 'set_settings', change: parseSettingsChange(command.settings) }
            : command.action === 'set_proxy_credentials'
              ? { action: 'set_proxy_credentials', credentials: parseProxyCredentials(command.credentials) }
              : command;
        if (this.changing) return fail('BUSY');
        this.changing = true;
        const abort = new AbortController();
        const done = this.runDirect(direct, abort.signal);
        this.direct = { owner, abort, done };
        try {
          return await done;
        } finally {
          this.direct = undefined;
          this.changing = false;
        }
      }
      const change = parseChange(command);
      if (!change) return fail('INVALID_INPUT');
      if (change?.action === 'install' && change.source.kind !== 'file') {
        if (!this.onlineAllowed()) return fail('ONLINE_INSTALL_DISABLED');
        // An early answer for the screen; the change checks the settings again under the lock.
        const stored = await this.storedSettings();
        const { settings, unreadable } = stored;
        if (unreadable) return fail('SETTINGS_UNREADABLE');
        if (!settings.onlineInstall) return fail('ONLINE_INSTALL_DISABLED');
        if (change.proxyCredentials && settings.proxy === null)
          return fail('INVALID_INPUT', ['proxy credentials were sent, but no proxy is set']);
        // The credentials are for this address; the change ends if the settings name another by then.
        if (change.proxyCredentials && settings.proxy !== null) change.proxyCredentialsFor = settings.proxy;
        // The screen asks for credentials on this answer; nothing has started.
        if (settings.proxy !== null && settings.proxyAuthentication && !change.proxyCredentials) {
          const layout = await locateLayout(this.options.root);
          if (!(await hasSavedCredentials(layout, this.vault, settings.proxy, stored.credentialId)))
            return fail('PROXY_CREDENTIALS_REQUIRED');
        }
      } else if (change.action === 'install' && change.proxyCredentials)
        return fail('INVALID_INPUT', ['a file import runs offline and takes no proxy credentials']);
      if (this.platform === 'win32' && change?.action === 'install' && change.source.kind === 'git')
        return fail('UNSUPPORTED_PLATFORM');
      if (this.changing) return fail('BUSY');
      this.changing = true;
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

  private async runDirect(command: DirectCommand, signal: AbortSignal): Promise<ExtensionReply> {
    try {
      const context = await this.context(signal);
      if (!context) return fail('RUNTIME_UNAVAILABLE');
      if (command.action === 'set_default')
        return { ok: true, data: await setDefault(context, command.extensionId, command.enabled) };
      if (command.action === 'set_settings')
        return { ok: true, data: await this.settingsState(await saveSettings(context, command.change)) };
      if (command.action === 'set_proxy_credentials')
        return { ok: true, data: await this.settingsState(await setProxyCredentials(context, command.credentials)) };
      if (command.action === 'clear_proxy_credentials')
        return { ok: true, data: await this.settingsState(await clearProxyCredentials(context)) };
      const data = command.action === 'reconcile_bundle' ? await reconcileBundle(context) : await rollback(context);
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
    if (replaceIncompatible !== undefined && typeof replaceIncompatible !== 'boolean') return undefined;
    // Credentials of the request stay in this object, which only the running change holds.
    const proxyCredentials =
      command.proxyCredentials === undefined ? undefined : parseProxyCredentials(command.proxyCredentials);
    return { action: 'install', source, replaceIncompatible, ...(proxyCredentials ? { proxyCredentials } : {}) };
  }
  // An update installs a file offline: it has no proxy to sign in to.
  if ((command as Record<string, unknown>).proxyCredentials !== undefined)
    throw new ExtensionFailure('INVALID_INPUT', ['an update runs offline and takes no proxy credentials']);
  return source.kind === 'file' && isName(command.name) ? { action: 'update', name: command.name, source } : undefined;
}
