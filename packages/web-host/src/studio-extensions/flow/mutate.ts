import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAdapterReference } from '../inspect/metadata.js';
import {
  contentDistributions,
  readSite,
  refuseSharedFiles,
  removeInstalledDirectUrl,
  verifyRecordFiles,
  type SiteSnapshot,
} from '../inspect/site.js';
import { compareInstalledVersions, parseVersion, specifierExcludes } from '../inspect/version.js';
import type { WheelFacts } from '../inspect/wheel.js';
import { runToExit, type RunResult } from '../process.js';
import { discardStage, promoteImport, readStoredImport, stageImport, type ImportSet } from '../store/artifacts.js';
import { collect, recover } from '../store/cleanup.js';
import {
  ensureLayout,
  generationId,
  generationPaths,
  readBundleFacts,
  sameBinding,
  verifyLayout,
  writeConstraints,
  type BundleFacts,
} from '../store/layout.js';
import { acquireMutationLock, removeFromState, type MutationLock } from '../store/lock.js';
import {
  newGenerationRecord,
  newPointer,
  readGenerationRecord,
  readPointer,
  recordedDefault,
  retainedDefaults,
  switchPointer,
  writeGenerationRecord,
  type GenerationRecord,
  type PointerState,
  type RecordedDistribution,
} from '../store/pointer.js';
import {
  ExtensionFailure,
  type ExtensionFailureCode,
  type ExtensionListing,
  type ExtensionOrigin,
  type ExtensionPhase,
  type ExtensionRollback,
  type ExtensionSettings,
  type ExtensionSource,
  type FileExtensionSource,
  type OnlineExtensionSource,
  type ProxyCredentials,
} from '../types.js';
import {
  chooseForms,
  conversationReference,
  launchFormOf,
  loadedNames,
  writePacks,
  type ExtensionForm,
  type LaunchForm,
} from '../launch/form.js';
import { managedExtensionId, writeManagedCatalog } from '../launch/managedCatalog.js';
import { createCandidate, scanGeneration, type Candidate, type FlowContext } from './candidate.js';
import { managementEnvironment, type OnlineAccess } from './environment.js';
import {
  compareRequest,
  nativeHandle,
  redactPaths,
  resolveDistribution,
  runLoadCheck,
  verifyManagedCatalog,
  type ChangeRequest,
  type ExpectedExtensions,
  type LoadExpectation,
} from './gate.js';
import { checkImport } from './importCheck.js';
import { fetchGitSource, type GitCheckout } from './online/checkout.js';
import {
  archiveRequirement,
  BOUNDED_INDEX_PIP,
  INDEX_RESPONSE_LIMIT,
  PIP_RESPONSE_LIMIT_EXIT,
  readResolutionReport,
  requestedArchive,
  RESOLUTION_REPORT_LIMIT,
  type ResolvedArchive,
} from './online/indexPip.js';
import { privateGitAccess } from './online/credentials.js';
import {
  dropProxyCredentials,
  MEMORY_ONLY_VAULT,
  openSavedCredentials,
  saveProxyCredentials,
} from './online/proxy/credentials.js';
import { startProxyRelay, type ProxyRelay } from './online/proxy/relay.js';
import { readSettings, writeSettings, type SettingsChange, type StoredSettings } from './online/settings.js';
import {
  indexRequirement,
  installedCheckoutOrigin,
  installedGitOrigin,
  matchesVersion,
  onlineIndex,
  parseIndexRequirement,
  pinnedGit,
  recordVerifiedSource,
  upgradeSource,
  verifyUpgradeSource,
  type IndexSource,
} from './online/source.js';

type RequestCredentials = {
  proxyCredentials?: ProxyCredentials;
  /** Per-request credentials belong to the proxy seen before the change took the lock. */
  proxyCredentialsFor?: string;
};
type InstallRequest = {
  action: 'install';
  source: ExtensionSource;
  replaceIncompatible?: boolean;
} & RequestCredentials;
type UpgradeRequest = { action: 'upgrade'; name: string; allowUnpin?: boolean } & RequestCredentials;

export type MutationRequest =
  | InstallRequest
  | UpgradeRequest
  | { action: 'update'; name: string; source: FileExtensionSource }
  | { action: 'remove'; name: string };

export type MutationHooks = {
  progress(phase: Extract<ExtensionPhase, 'checking' | 'preparing' | 'installing' | 'verifying'>): void;
  /** Four hex characters that make a generation name unique. */
  suffix(): string;
  now(): Date;
};

export type MutationOutcome = { generation: string; revision: number } | { alreadyLatest: true };

const EMPTY_SITE: SiteSnapshot = {
  distributions: new Map(),
  extensions: new Map(),
  topLevel: new Set(),
  startup: [],
  problems: [],
};

/**
 * native's exit code for "installed, but a manifest of the pack will not bind". Such a pack
 * still loads; what its manifest declares stays inert. It is installed and listed as
 * `manifest_unbound`, not refused: only a pack that fails to load is refused (decision A2).
 */
const INSTALLED_NOT_BOUND = 3;

/** How long a reason taken from native's own words may be. */
const REASON_LIMIT = 500;

/** Turn the end of a helper child into a failure, or return when it exited with an accepted code. */
function requireSuccess(
  result: RunResult,
  codes: Record<number, ExtensionFailureCode>,
  what: string,
  accepted: number[] = [0]
): void {
  if (result.cancelled) throw new ExtensionFailure('CANCELLED');
  if (result.timedOut) throw new ExtensionFailure('TIMEOUT', [`${what} took too long`], result.output);
  if (result.code !== null && accepted.includes(result.code)) return;
  const code = (result.failedToStart ? codes[2] : result.code !== null && codes[result.code]) || codes[1];
  throw new ExtensionFailure(code, [`${what} ended with exit code ${String(result.code)}`], result.output);
}

/**
 * Run the native CLI in the management form (ADR 5.2): the generation's venv interpreter,
 * `site` enabled. Call it only for a generation that passed the static scan.
 */
function runManagement(
  context: FlowContext,
  candidate: Candidate,
  env: Record<string, string>,
  native: string[],
  timeoutMs: number,
  cwd = candidate.paths.directory
): Promise<RunResult> {
  return runToExit(
    context.spawn,
    {
      command: candidate.paths.python,
      args: ['-I', '-B', '-X', 'utf8', context.bundle.launcher, 'native', ...native],
      env,
      cwd,
    },
    // Git (in pip) prints remote and submodule addresses as written, which can carry a token.
    { timeoutMs, signal: context.signal, redact: true, secrets: context.secrets }
  );
}

/**
 * Ask `aelix extension verify` which manifests bind (ADR 5.5). The answer is recorded for
 * the list; an unbound manifest does not fail the change. One run covers every extension;
 * only when some manifest does not bind is each extension asked about separately.
 *
 * This is native's verdict for the installed entry point. It says nothing about whether a
 * conversation, which loads the extension by module reference, attaches the manifest.
 */
async function manifestBindings(
  context: FlowContext,
  candidate: Candidate,
  env: Record<string, string>,
  expected: ExpectedExtensions
): Promise<Map<string, boolean>> {
  const bound = new Map<string, boolean>();
  if (expected.size === 0) return bound;
  const verify = async (name?: string): Promise<boolean> => {
    const result = await runManagement(
      context,
      candidate,
      env,
      ['extension', 'verify', ...(name === undefined ? [] : [name])],
      context.timeouts.verifyMs
    );
    if (result.code === 1 && !result.cancelled && !result.timedOut) return false;
    requireSuccess(result, { 1: 'VERIFICATION_FAILED' }, 'extension verify');
    return true;
  };
  const all = await verify();
  for (const name of expected.keys()) {
    // oxlint-disable-next-line no-await-in-loop -- one native process at a time
    bound.set(name, all || (await verify(name)));
  }
  return bound;
}

type Installer = { native: string[]; importSet?: ImportSet; wheels: WheelFacts[] };
type Preparation = Installer & { change: ChangeRequest };
type OnlineInstaller = Installer & { source: OnlineExtensionSource; upgrade?: string };

function prepareOnline(source: OnlineExtensionSource, upgrade?: string): OnlineInstaller {
  const target = source.kind === 'index' ? nativeIndexTarget(source) : source.url;
  const args = source.kind === 'index' ? ['--index-url', onlineIndex(source)] : [];
  return { source, upgrade, native: ['extension', 'install', target, ...args, '--yes'], wheels: [] };
}

function nativeIndexTarget(source: IndexSource): string {
  const { name, specifier } = indexRequirement(source);
  const target = name + specifier;
  // Native recognizes a trailing .git as a repository, even in a version label.
  return target.toLowerCase().endsWith('.git') ? `${name}(${specifier})` : target;
}

/** Work out what the request means against the current generation, and store an import. */
async function prepare(
  context: FlowContext,
  lock: MutationLock,
  request: MutationRequest,
  before: SiteSnapshot,
  bundle: BundleFacts,
  parent: GenerationRecord | null,
  beforeSite: string | undefined
): Promise<Preparation | OnlineInstaller> {
  const name = request.action === 'install' ? undefined : request.name;
  const resolution = name === undefined ? undefined : resolveDistribution(before, name);
  if (resolution && 'ambiguous' in resolution)
    throw new ExtensionFailure('AMBIGUOUS_NAME', [
      `${String(name)} fits more than one extension: ${resolution.ambiguous.join(', ')}`,
    ]);
  const owner = resolution && 'distribution' in resolution ? resolution.distribution : undefined;
  if (name !== undefined && owner === undefined)
    throw new ExtensionFailure('NOT_INSTALLED', [`no installed extension provides ${name}`]);
  if (request.action === 'remove') {
    // native compares names loosely and takes the first that fits, so it gets a name only this one has.
    const handle = nativeHandle(before, owner ?? '');
    if (handle === undefined)
      throw new ExtensionFailure('AMBIGUOUS_NAME', [`native cannot tell ${request.name} from another extension`]);
    return {
      change: { action: 'remove', distribution: owner ?? '' },
      native: ['extension', 'remove', handle, '--yes'],
      wheels: [],
    };
  }
  if (request.action === 'upgrade') {
    const distribution = resolution && 'distribution' in resolution ? resolution.distribution : '';
    const origin = parent?.distributions[distribution]?.origin;
    const source = upgradeSource(origin, distribution);
    if (origin?.kind !== 'git' && origin?.kind !== 'index') throw new ExtensionFailure('UPGRADE_UNAVAILABLE');
    if (!source) throw new ExtensionFailure('UPGRADE_SOURCE_MISMATCH');
    if (source.kind === 'git' && context.platform === 'win32') throw new ExtensionFailure('UNSUPPORTED_PLATFORM');
    const recorded = parent?.distributions[distribution];
    const installed = before.distributions.get(distribution);
    if (
      !beforeSite ||
      !installed ||
      recorded?.version !== installed.version ||
      recorded.recordSha256 !== installed.recordSha256
    )
      throw new ExtensionFailure('GENERATION_MODIFIED');
    await verifyUpgradeSource(beforeSite, source, origin, installed);
    if (origin.kind === 'git' && source.kind === 'git' && pinnedGit(source, origin.commit))
      throw new ExtensionFailure('PINNED');
    if (source.kind === 'index' && indexRequirement(source).exact) throw new ExtensionFailure('PINNED');
    if (origin.kind === 'index' && origin.requirement === undefined && !request.allowUnpin)
      throw new ExtensionFailure('PIN_UNKNOWN');
    return prepareOnline(source, distribution);
  }
  if (request.source.kind !== 'file') return prepareOnline(request.source);
  const staged = await stageImport(context.layout, request.source, lock);
  try {
    const check = await checkImport(staged.target, staged.files, bundle);
    if (check.problems.length > 0 || !check.target)
      throw new ExtensionFailure(
        check.problems[0]?.code ?? 'INVALID_WHEEL',
        check.problems.map((problem) => problem.message)
      );
    if (request.action === 'update' && owner !== check.target.name)
      throw new ExtensionFailure('REQUEST_MISMATCH', [
        `${check.target.filename} is ${check.target.name}; ${request.name} is provided by ${String(owner)}`,
      ]);
    const importSet = await promoteImport(context.layout, staged, lock);
    return {
      change: { action: request.action, distribution: check.target.name, version: check.target.version },
      // A file import always runs offline: no index, wheels from the stored set only (ADR 5.9).
      native: ['--offline', 'extension', 'install', importSet.target, '--yes'],
      importSet,
      wheels: check.wheels,
    };
  } catch (error) {
    await discardStage(context.layout, staged, lock).catch(() => {});
    throw error;
  }
}

/**
 * What the user's settings give an online install: their proxy, and for a git source with
 * private Git on, the user's SSH agent and Git credential helpers. A name install keeps the
 * isolated Git and SSH of PR #77 whatever private Git says: it has no repository to sign in to.
 * Windows has no git installs, so no private Git.
 */
async function onlineAccess(
  context: FlowContext,
  settings: ExtensionSettings,
  proxy: string | undefined,
  source: OnlineExtensionSource,
  home: string
): Promise<OnlineAccess> {
  const access: OnlineAccess = {};
  if (proxy !== undefined) access.proxy = proxy;
  if (source.kind === 'git' && settings.privateGit && context.platform !== 'win32')
    access.privateGit = await privateGitAccess(context, home, context.timeouts.verifyMs);
  return access;
}

/**
 * The proxy of an online install and the credentials it signs in with, if it asks for them:
 * those of the request, else the saved ones. Read under the lock, from the settings the
 * change uses.
 *
 * @throws ExtensionFailure `PROXY_CHANGED` when the request's credentials were checked against
 * another proxy; `PROXY_CREDENTIALS_REQUIRED` when the proxy asks for credentials and none are
 * at hand
 */
async function installProxy(
  context: FlowContext,
  stored: StoredSettings,
  request: InstallRequest | UpgradeRequest
): Promise<{ proxy: string; credentials?: ProxyCredentials } | undefined> {
  const { proxy, proxyAuthentication } = stored.settings;
  const vault = context.proxyVault ?? MEMORY_ONLY_VAULT;
  // Another Studio process changed the proxy after the request was checked: its credentials
  // were typed for the earlier address and go nowhere.
  if (request.proxyCredentials && request.proxyCredentialsFor === undefined && proxy === null)
    throw new ExtensionFailure('INVALID_INPUT', ['proxy credentials were sent, but no proxy is set']);
  if (request.proxyCredentials && request.proxyCredentialsFor !== proxy)
    throw new ExtensionFailure('PROXY_CHANGED', ['the proxy changed after the request was checked']);
  if (proxy === null) return undefined;
  const credentials =
    request.proxyCredentials ??
    (proxyAuthentication ? await openSavedCredentials(context.layout, vault, proxy, stored.credentialId) : undefined);
  if (proxyAuthentication && !credentials)
    throw new ExtensionFailure('PROXY_CREDENTIALS_REQUIRED', [
      vault.mode === 'memory-only'
        ? 'proxy credentials are not kept here; send them with the request'
        : 'no saved proxy credentials could be opened; send them with the request or save them again',
    ]);
  return credentials ? { proxy, credentials } : { proxy };
}

/**
 * `PROXY_CREDENTIALS_REJECTED` for a run that failed on its own while the user's proxy had
 * answered the relay with 407. A cancelled or timed-out change, or one that lost its lock,
 * keeps that outcome: the refusal is only what the installer met on the way.
 */
function rejectedCredentials(
  context: FlowContext,
  relay: ProxyRelay | undefined,
  failed: { cancelled?: boolean; timedOut?: boolean; output?: string }
): ExtensionFailure | undefined {
  if (!relay?.credentialsRejected() || failed.cancelled || failed.timedOut || context.signal?.aborted) return undefined;
  return new ExtensionFailure('PROXY_CREDENTIALS_REJECTED', ['the proxy refused the credentials'], failed.output);
}

type InstallerEnvironment = Awaited<ReturnType<typeof onlineEnvironment>>;

async function onlineEnvironment(
  context: FlowContext,
  agentDirectory: string,
  constraintsUrl: string,
  source: OnlineExtensionSource,
  settings: ExtensionSettings,
  proxy: string | undefined,
  directory: string
) {
  const cwd = path.join(directory, 'install-work');
  const home = path.join(directory, 'install-home');
  await Promise.all([mkdir(cwd), mkdir(home, { mode: 0o700 })]);
  const env = managementEnvironment(context.base, context.platform, {
    agentDirectory,
    nativeSite: context.bundle.nativeSite,
    constraintsUrl,
    online: {
      indexUrl: onlineIndex(source),
      home,
      work: cwd,
      access: await onlineAccess(context, settings, proxy, source, home),
    },
  });
  return { env, cwd };
}

function runPip(
  context: FlowContext,
  python: string,
  installer: InstallerEnvironment,
  args: string[],
  limitIndexResponses = false
): Promise<RunResult> {
  const pip = limitIndexResponses
    ? ['-c', BOUNDED_INDEX_PIP, String(INDEX_RESPONSE_LIMIT), String(RESOLUTION_REPORT_LIMIT)]
    : ['-m', 'pip'];
  return runToExit(
    context.spawn,
    { command: python, args: ['-P', '-B', ...pip, ...args], ...installer },
    { timeoutMs: context.timeouts.installerMs, signal: context.signal, redact: true, secrets: context.secrets }
  );
}

async function fetchForInstall(
  context: FlowContext,
  lock: MutationLock,
  env: Record<string, string>,
  source: Extract<OnlineExtensionSource, { kind: 'git' }>,
  relay?: ProxyRelay,
  installedCommit?: string
) {
  try {
    return await fetchGitSource(context, lock, env, source, context.timeouts.installerMs, installedCommit);
  } catch (error) {
    if (error instanceof ExtensionFailure && error.code === 'GIT_FETCH_FAILED')
      throw rejectedCredentials(context, relay, { output: error.output }) ?? error;
    throw error;
  }
}

/** Probe the saved index in a disposable environment. Ignore installed packages so an
 * unreachable index cannot look like an up-to-date installation. The real install resolves
 * dependencies under the same bundle constraints. */
async function resolveIndexUpgrade(
  context: FlowContext,
  probe: Candidate,
  installer: InstallerEnvironment,
  source: IndexSource,
  relay?: ProxyRelay
): Promise<ResolvedArchive> {
  const deadline = performance.now() + context.timeouts.installerMs;
  const report = path.join(probe.paths.directory, 'resolution.json');
  const result = await runPip(
    context,
    probe.paths.python,
    installer,
    ['install', '--dry-run', '--report', report, '--ignore-installed', '--no-deps', nativeIndexTarget(source)],
    true
  );
  refuseSizeLimit(result);
  if (result.code !== 0) {
    const refused = rejectedCredentials(context, relay, result);
    if (refused) throw refused;
  }
  requireSuccess(result, { 1: 'INSTALLER_FAILED', 2: 'INSTALLER_NOT_RUN' }, 'resolving the index requirement');
  const target = requestedArchive(await readResolutionReport(report, deadline, context.signal));
  const { name, version } = target.metadata ?? {};
  const wanted = indexRequirement(source).name;
  const reported = parseIndexRequirement(name);
  if (reported?.name !== wanted || reported.specifier || typeof version !== 'string' || !parseVersion(version))
    throw new ExtensionFailure('REQUEST_MISMATCH', ['pip resolved an unexpected name or version']);
  const requirement = archiveRequirement(wanted, target);
  if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
  if (performance.now() >= deadline) throw new ExtensionFailure('TIMEOUT');
  return { version, requirement };
}

function refuseSizeLimit(result: RunResult): void {
  if (result.code === PIP_RESPONSE_LIMIT_EXIT && !result.cancelled && !result.timedOut)
    throw new ExtensionFailure('UPGRADE_RESPONSE_TOO_LARGE');
}

/** The record of a verified candidate: what it holds and where each distribution came from. */
function describeMutation(
  context: FlowContext,
  candidate: Candidate,
  parent: GenerationRecord | null,
  request: MutationRequest,
  preparation: Preparation,
  snapshot: SiteSnapshot,
  initial: SiteSnapshot,
  bound: Map<string, boolean>,
  forms: Map<string, ExtensionForm>,
  launch: LaunchForm,
  createdAt: Date,
  onlineOrigin?: ExtensionOrigin
): GenerationRecord {
  const imported = (name: string, version: string): ExtensionOrigin | undefined => {
    const wheel = preparation.wheels.find((facts) => facts.name === name && facts.version === version);
    const sha256 = wheel && preparation.importSet?.digests[wheel.filename];
    return preparation.importSet && wheel && sha256
      ? { kind: 'file', artifact: preparation.importSet.id, wheel: wheel.filename, sha256 }
      : undefined;
  };
  const distributions: Record<string, RecordedDistribution> = Object.create(null);
  for (const { name, version, recordSha256 } of contentDistributions(snapshot)) {
    const inherited = parent?.distributions[name];
    // An untouched distribution keeps its origin; one this change wrote came from the import set.
    const copied = initial.distributions.get(name);
    const untouched = inherited && copied?.version === version && copied.recordSha256 === recordSha256;
    const origin =
      name === preparation.change.distribution && onlineOrigin
        ? onlineOrigin
        : untouched
          ? inherited.origin
          : imported(name, version);
    distributions[name] = { version, recordSha256, ...(origin ? { origin } : {}) };
  }
  const operation = {
    action: request.action,
    target: request.action === 'remove' ? request.name : preparation.change.distribution,
  };
  return describeCandidate(
    context,
    candidate,
    parent,
    operation,
    distributions,
    snapshot,
    { bound, forms, launch },
    createdAt
  );
}

function describeCandidate(
  context: FlowContext,
  candidate: Candidate,
  parent: GenerationRecord | null,
  operation: GenerationRecord['operation'],
  distributions: GenerationRecord['distributions'],
  snapshot: SiteSnapshot,
  { bound, forms, launch }: Awaited<ReturnType<typeof verifyCandidate>>,
  createdAt: Date
): GenerationRecord {
  const extensions: GenerationRecord['extensions'] = Object.create(null);
  for (const [name, extension] of snapshot.extensions) {
    const form = forms.get(name);
    extensions[name] = {
      reference: extension.reference,
      distribution: extension.distribution,
      manifestBound: bound.get(name) ?? false,
      form: form?.form ?? 'module',
      plugin: form?.form === 'pack' ? form.plugin : null,
    };
  }
  return newGenerationRecord({
    generation: candidate.id,
    parent: parent?.generation ?? null,
    createdAt: createdAt.toISOString(),
    binding: context.bundle.binding,
    operation,
    distributions,
    extensions,
    launch,
  });
}

/**
 * Take the lock, undo interrupted work, read the pointer: the start of every change (ADR 5.6).
 * The state directory is checked first: the helper removes things from it, so it has to be
 * the helper's own.
 */
async function begin(context: FlowContext): Promise<{ lock: MutationLock; base: PointerState }> {
  await ensureLayout(context.layout);
  const lock = await acquireMutationLock({
    bundle: context.bundle,
    layout: context.layout,
    spawn: context.spawn,
    env: context.base,
    waitMs: context.timeouts.lockMs,
    signal: context.signal,
  });
  try {
    await recover(context.layout, lock);
    // Sealed proxy credentials the settings do not name: what a save or a clearing left when
    // it was interrupted between writing the settings and removing the older file. Settings
    // that cannot be read name nothing we can trust: then no sealed file is touched, so the
    // credentials still open once the settings are restored.
    const named = await readSettings(context.layout);
    if (!named.unreadable) await dropProxyCredentials(context.layout, lock, named.credentialId);
    return { lock, base: await readPointer(context.layout) };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** The context for work under a lock: everything it starts is stopped the moment the lock is lost. */
function underLock(context: FlowContext, lock: MutationLock): FlowContext {
  return { ...context, signal: context.signal ? AbortSignal.any([context.signal, lock.loss]) : lock.loss };
}

/** Clean-up under the lock. A failure here never changes the outcome of the change. */
async function tidy(context: FlowContext, lock: MutationLock): Promise<void> {
  try {
    await collect({
      bundle: context.bundle,
      layout: context.layout,
      spawn: context.spawn,
      env: context.base,
      writer: lock,
    });
  } catch {
    // Left for the next change to clean up.
  }
}

/**
 * Run a load check and end the change unless everything expected loaded. Reasons are native's
 * own words, cut to length, with the locations of this machine replaced by labels.
 */
async function loadOrRefuse(
  context: FlowContext,
  candidate: Candidate,
  sources: string[],
  expected: LoadExpectation
): Promise<void> {
  const load = await runLoadCheck(context, candidate, sources, expected);
  if (load.cancelled) throw new ExtensionFailure('CANCELLED');
  if (load.timedOut) throw new ExtensionFailure('TIMEOUT', ['the load check took too long']);
  const locations: [string, string][] = [
    [candidate.paths.directory, '<generation>'],
    [context.layout.root, '<extensions>'],
    [context.bundle.root, '<runtime>'],
    [os.homedir(), '~'],
  ];
  const reasons = load.problems.map((problem) => redactPaths(problem, locations).slice(0, REASON_LIMIT));
  if (!load.answered) throw new ExtensionFailure('VERIFICATION_FAILED', reasons);
  if (reasons.length > 0) throw new ExtensionFailure('LOAD_ERROR', reasons);
}

async function verifyCandidate(
  context: FlowContext,
  candidate: Candidate,
  env: Record<string, string>,
  snapshot: SiteSnapshot,
  expected: ExpectedExtensions,
  unboundDistribution?: string
): Promise<{ bound: Map<string, boolean>; forms: Map<string, ExtensionForm>; launch: LaunchForm }> {
  await verifyRecordFiles(candidate.paths.site, candidate.paths.venv, snapshot, context.signal);
  const bound = await manifestBindings(context, candidate, env, expected);
  // The installer's verdict stands even when `extension verify` does not repeat it.
  if (unboundDistribution !== undefined && [...bound.values()].every(Boolean))
    for (const [name, extension] of snapshot.extensions)
      if (extension.distribution === unboundDistribution) bound.set(name, false);
  const forms = await chooseForms(context, candidate, snapshot, expected, bound);
  const launch = launchFormOf(expected, forms);
  const unsupported = launch.modules.filter((reference) => !isAdapterReference(reference));
  if (unsupported.length > 0)
    throw new ExtensionFailure(
      'LOAD_ERROR',
      unsupported.map((reference) => `${reference} cannot be passed to a conversation by module reference`)
    );
  await writePacks(candidate, forms);
  launch.managed = await writeManagedCatalog(candidate, snapshot, expected, forms);
  await verifyManagedCatalog(context, candidate, launch.managed);
  // Every extension by reference, in the order conversations get them: imports each and runs
  // its setup() now, lazy pack or not. Without packs this is exactly what conversations get.
  const byReference = new Map(
    [...expected].map(([name, reference]): [string, string] => [name, conversationReference(reference)])
  );
  const references = [...new Set([...byReference.keys()].toSorted().map((name) => byReference.get(name) ?? ''))];
  await loadOrRefuse(context, candidate, references, byReference);
  // Then exactly the way new conversations get them, which binds the manifests of the packs.
  if (launch.packs)
    await loadOrRefuse(
      context,
      candidate,
      launch.managed.map(({ reference, entryPoints }) =>
        entryPoints ? path.join(candidate.paths.directory, ...reference.split('/')) : reference
      ),
      loadedNames(expected, forms)
    );

  return { bound, forms, launch };
}

/** Whether the pointer in effect names a generation as current or previous: then clean-up keeps it. */
async function inEffect(layout: FlowContext['layout'], generation: string): Promise<boolean> {
  const pointer = await readPointer(layout).then(
    (state) => state.pointer,
    (): null => null
  );
  return pointer?.generation === generation || pointer?.previous === generation;
}

/** What ended a change under a lock: the loss of the lock outranks whatever it caused. */
function outcome(error: unknown, lock: MutationLock): unknown {
  return lock.lost() ? new ExtensionFailure('CONFLICT', ['the lock was lost while the change was in progress']) : error;
}

/** Publish a verified candidate only if the pointer and lock still belong to this change. */
async function commitCandidate(
  context: FlowContext,
  lock: MutationLock,
  base: PointerState,
  record: GenerationRecord
): Promise<void> {
  const { layout } = context;
  const revision = base.pointer?.revision ?? 0;
  await writeGenerationRecord(layout, record);
  const latest = await readPointer(layout);
  if (
    lock.lost() ||
    (latest.pointer?.revision ?? 0) !== revision ||
    latest.pointer?.generation !== base.pointer?.generation
  )
    throw new ExtensionFailure('CONFLICT', ['the current generation changed while this one was prepared']);
  if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
  await switchPointer(
    layout,
    newPointer(
      record.generation,
      base.pointer?.generation ?? null,
      revision + 1,
      record.binding,
      retainedDefaults(base, record)
    ),
    base.pointer,
    lock
  );
}

/**
 * Install, update or remove an extension (D04 ADR 5.4). The change is made in a candidate
 * generation; the pointer moves only after the static scan, the installer, the comparison
 * of request and result and the load check all passed. On any failure the candidate is
 * removed and the current generation is untouched.
 *
 * An install whose manifest does not bind goes through the same checks and is recorded as
 * such; every other non-zero exit of the installer ends the change.
 *
 * Shared state (the pointer files, and everything that is removed) is written by the lock
 * holder, so none of it changes after the lock is gone; losing the lock stops what is
 * running and ends the change with `CONFLICT`.
 *
 * @throws ExtensionFailure with the reason; see `ExtensionFailureCode`.
 */
export async function mutate(
  context: FlowContext,
  request: MutationRequest,
  hooks: MutationHooks
): Promise<MutationOutcome> {
  hooks.progress('checking');
  const { lock, base } = await begin(context);
  const guarded = underLock(context, lock);
  let unfinished: string | undefined;
  let relay: ProxyRelay | undefined;
  let checkout: GitCheckout | undefined;
  let staging: string | undefined;
  try {
    const { bundle, layout, platform } = guarded;
    const stale = base.record && !sameBinding(base.record.binding, bundle.binding);
    if (stale && !(request.action === 'install' && request.replaceIncompatible))
      throw new ExtensionFailure('BUNDLE_CHANGED', ['the installed extensions belong to another Studio runtime']);
    // The settings this change uses: read once, under the lock, so none of them moves until it ends.
    const stored = await readSettings(layout);
    const { settings, unreadable } = stored;
    const onlineRequest =
      request.action === 'upgrade' || (request.action === 'install' && request.source.kind !== 'file');
    if (onlineRequest) {
      if (unreadable) throw new ExtensionFailure('SETTINGS_UNREADABLE', ['the extension settings cannot be read']);
      if (!settings.onlineInstall) throw new ExtensionFailure('ONLINE_INSTALL_DISABLED');
    }
    // A confirmed reinstall starts fresh and keeps the old record as the previous generation.
    const parent = stale ? null : base.record;
    const facts = await readBundleFacts(bundle);
    const beforeSite = parent && generationPaths(layout, parent.generation, parent.binding.pythonMinor, platform).site;
    const before = beforeSite ? await readSite(beforeSite) : EMPTY_SITE;
    const prepared = await prepare(guarded, lock, request, before, facts, parent, beforeSite || undefined);
    const source = 'source' in prepared ? prepared.source : undefined;
    const upgrade = 'upgrade' in prepared ? prepared.upgrade : undefined;
    const offlineImport = prepared.importSet !== undefined;
    let proxy: string | undefined;
    if (onlineRequest) {
      if (guarded.signal?.aborted) throw new ExtensionFailure('CANCELLED');
      const upstream = await installProxy(guarded, stored, request);
      // Credentials typed where nothing is kept replace any a keychain saved for this proxy:
      // keeping those would bring back the old password the next time a keychain is there.
      if (request.proxyCredentials && (guarded.proxyVault ?? MEMORY_ONLY_VAULT).mode === 'memory-only') {
        if (stored.credentialId !== null) await writeSettings(layout, settings, null, lock);
        await dropProxyCredentials(layout, lock, null);
      }
      // The installers never get the credentials: they get the relay, which signs in for them.
      if (upstream?.credentials) relay = await startProxyRelay(upstream.proxy, upstream.credentials);
      proxy = relay?.url ?? upstream?.proxy;
    }
    // What the installers print is masked for the relay token too, in or outside a URL.
    const online: FlowContext = relay ? { ...guarded, secrets: relay.secrets } : guarded;
    const constraintsUrl = await writeConstraints(layout, bundle, facts);
    const revision = base.pointer?.revision ?? 0;
    let resolvedArchive: ResolvedArchive | undefined;
    let resolvedCommit: string | undefined;
    if (upgrade && source) {
      staging = path.join(layout.artifacts, '.staging-upgrade-' + randomBytes(6).toString('hex'));
      await mkdir(staging, { mode: 0o700 });
      if (source.kind === 'index') {
        const probe = await createCandidate(guarded, 'probe', null, false, staging);
        const scan = await scanGeneration(probe, facts, false);
        if (scan.problems.length > 0)
          throw new ExtensionFailure(
            scan.problems[0].code,
            scan.problems.map(({ message }) => message)
          );
        const installer = await onlineEnvironment(
          guarded,
          probe.paths.agent,
          constraintsUrl,
          source,
          settings,
          proxy,
          staging
        );
        resolvedArchive = await resolveIndexUpgrade(online, probe, installer, source, relay);
        const currentVersion = parseVersion(before.distributions.get(upgrade)?.version ?? '');
        const latestVersion = parseVersion(resolvedArchive.version);
        if (!currentVersion || !latestVersion) throw new ExtensionFailure('REQUEST_MISMATCH');
        if (guarded.signal?.aborted) throw new ExtensionFailure('CANCELLED');
        if (compareInstalledVersions(latestVersion, currentVersion) <= 0) return { alreadyLatest: true };
      } else {
        const installer = await onlineEnvironment(
          guarded,
          path.join(staging, 'agent'),
          constraintsUrl,
          source,
          settings,
          proxy,
          staging
        );
        const origin = parent?.distributions[upgrade]?.origin;
        const fetched = await fetchForInstall(
          online,
          lock,
          installer.env,
          source,
          relay,
          origin?.kind === 'git' ? origin.commit : undefined
        );
        checkout = fetched.checkout;
        resolvedCommit = fetched.commit;
      }
      if (guarded.signal?.aborted) throw new ExtensionFailure('CANCELLED');
      const origin = parent?.distributions[upgrade]?.origin;
      if (origin?.kind === 'git' && resolvedCommit === origin.commit) return { alreadyLatest: true };
      await removeFromState(layout, lock, staging);
      staging = undefined;
    }
    hooks.progress('preparing');
    unfinished = generationId(revision + 1, hooks.suffix());
    const candidate = await createCandidate(guarded, unfinished, parent);
    const refuse = (problems: { code: ExtensionFailureCode; message: string }[], output?: string): void => {
      if (problems.length > 0)
        throw new ExtensionFailure(
          problems[0].code,
          problems.map((problem) => problem.message),
          output
        );
    };
    const initial = await scanGeneration(candidate, facts, offlineImport);
    refuse(initial.problems);

    hooks.progress('installing');
    const management = { agentDirectory: candidate.paths.agent, nativeSite: bundle.nativeSite, constraintsUrl };
    // native treats an existing relative path as a local install, even when it looks like a package name.
    const isolated = managementEnvironment(guarded.base, platform, {
      ...management,
      ...(prepared.importSet ? { offlineLinksUrl: pathToFileURL(prepared.importSet.directory).href } : {}),
    });
    const installerEnvironment = source
      ? await onlineEnvironment(
          guarded,
          candidate.paths.agent,
          constraintsUrl,
          source,
          settings,
          proxy,
          candidate.paths.directory
        )
      : { env: isolated, cwd: candidate.paths.directory };
    if (!checkout && source?.kind === 'git' && source.subdirectory !== undefined)
      checkout = (await fetchForInstall(online, lock, installerEnvironment.env, source, relay)).checkout;
    if (upgrade && source?.kind === 'git') refuseSharedFiles(candidate.paths.site, initial.snapshot, upgrade, platform);
    let native = prepared.native;
    if (checkout) native = ['extension', 'install', checkout.directory, '--yes'];
    else if (upgrade && source) {
      if (source.kind === 'git') {
        // pip compares the distribution version during a Git update. Remove only this
        // distribution in the candidate so a new commit with the same version is installed.
        const removed = await runPip(guarded, candidate.paths.python, { ...installerEnvironment, env: isolated }, [
          'uninstall',
          '--yes',
          upgrade,
        ]);
        requireSuccess(removed, { 1: 'INSTALLER_FAILED' }, 'removing the old Git distribution');
      }
    }
    const installer = resolvedArchive
      ? await runPip(
          online,
          candidate.paths.python,
          installerEnvironment,
          ['install', resolvedArchive.requirement],
          true
        )
      : await runManagement(
          online,
          candidate,
          installerEnvironment.env,
          native,
          guarded.timeouts.installerMs,
          installerEnvironment.cwd
        );
    refuseSizeLimit(installer);
    // Nothing after the installer goes online; the relay and its token end here.
    await relay?.close();
    // An install the user's proxy refused to sign in is reported as that, so the screen can ask again.
    if (installer.code !== 0 && installer.code !== INSTALLED_NOT_BOUND) {
      const refused = rejectedCredentials(guarded, relay, installer);
      if (refused) throw refused;
    }
    // `extension remove` hands pip's own exit code through: there 2 and 3 are pip's, not
    // native's "did not run" and "not bound", so every non-zero code is a plain failure.
    if (request.action === 'remove') requireSuccess(installer, { 1: 'INSTALLER_FAILED' }, 'the installer');
    else
      requireSuccess(installer, { 1: 'INSTALLER_FAILED', 2: 'INSTALLER_NOT_RUN' }, 'the installer', [
        0,
        INSTALLED_NOT_BOUND,
      ]);
    // The candidate's interpreter is not started again unless this second scan passes.
    const scan = await scanGeneration(candidate, facts, offlineImport);
    refuse(scan.problems, installer.output);

    hooks.progress('verifying');
    let onlineOrigin: ExtensionOrigin | undefined;
    let preparation: Preparation;
    if ('change' in prepared) preparation = prepared;
    else if (prepared.source.kind === 'git') {
      const { distribution, origin } = checkout
        ? await installedCheckoutOrigin(
            prepared.source,
            candidate.paths.site,
            initial.snapshot,
            scan.snapshot,
            checkout
          )
        : await installedGitOrigin(prepared.source, candidate.paths.site, initial.snapshot, scan.snapshot);
      if (upgrade && (distribution !== upgrade || origin.kind !== 'git' || origin.commit !== resolvedCommit))
        throw new ExtensionFailure('REQUEST_MISMATCH', [
          'the upgrade did not install the selected Git distribution and commit',
        ]);
      preparation = { ...prepared, change: { action: upgrade ? 'update' : 'install', distribution } };
      onlineOrigin = origin;
    } else {
      const { name, specifier, text, exact } = indexRequirement(prepared.source);
      const version = scan.snapshot.distributions.get(name)?.version;
      if (
        version !== undefined &&
        (specifierExcludes(specifier, version) ||
          (exact?.startsWith('===') && version.toLowerCase() !== exact.slice(3).trim().toLowerCase()))
      )
        throw new ExtensionFailure('REQUEST_MISMATCH', [
          'the installed version does not satisfy the requested requirement',
        ]);
      preparation = {
        ...prepared,
        change:
          resolvedArchive !== undefined
            ? { action: 'update', distribution: name, version: resolvedArchive.version }
            : {
                action: 'install',
                distribution: name,
                version: exact?.startsWith('===') ? undefined : exact?.slice(2).trim(),
                matchesVersion,
              },
      };
      if (
        initial.snapshot.distributions.get(name)?.recordSha256 !== scan.snapshot.distributions.get(name)?.recordSha256
      )
        onlineOrigin = { kind: 'index', indexUrl: onlineIndex(prepared.source), requirement: text };
    }
    const gate = compareRequest(preparation.change, initial.snapshot, scan.snapshot);
    if (!gate.changed) throw new ExtensionFailure('NO_CHANGE', ['nothing was installed or removed'], installer.output);
    if (gate.problems.length > 0) throw new ExtensionFailure('REQUEST_MISMATCH', gate.problems, installer.output);
    const installed = scan.snapshot.distributions.get(preparation.change.distribution);
    if (installed && onlineOrigin) {
      if (resolvedArchive) await removeInstalledDirectUrl(candidate.paths.site, installed);
      await recordVerifiedSource(candidate.paths.site, installed, onlineOrigin);
    }
    const finalSnapshot = onlineOrigin ? await readSite(candidate.paths.site) : scan.snapshot;
    const { bound, forms, launch } = await verifyCandidate(
      guarded,
      candidate,
      managementEnvironment(guarded.base, platform, management),
      finalSnapshot,
      gate.expected,
      installer.code === INSTALLED_NOT_BOUND ? preparation.change.distribution : undefined
    );

    const record = describeMutation(
      guarded,
      candidate,
      parent,
      request,
      preparation,
      finalSnapshot,
      initial.snapshot,
      bound,
      forms,
      launch,
      hooks.now(),
      onlineOrigin
    );
    if (checkout) {
      await removeFromState(layout, lock, checkout.staging);
      checkout = undefined;
    }
    await commitCandidate(guarded, lock, base, record);
    unfinished = undefined;
    return { generation: candidate.id, revision: revision + 1 };
  } catch (error) {
    // Without the lock nothing is removed; the next change under a lock removes what is left.
    // A switch can fail after its rename took effect (flushing the directory, say): then the
    // candidate is in effect, and a launcher may already use it. It stays.
    if (unfinished !== undefined && !(await inEffect(context.layout, unfinished)))
      await lock.remove(`generations/${unfinished}`).catch(() => {});
    const proxyFailure =
      error instanceof ExtensionFailure &&
      (error.code === 'PROXY_CHANGED' ||
        error.code === 'PROXY_CREDENTIALS_REQUIRED' ||
        error.code === 'PROXY_CREDENTIALS_REJECTED');
    throw outcome(proxyFailure && context.signal?.aborted ? new ExtensionFailure('CANCELLED') : error, lock);
  } finally {
    await relay?.close();
    // Clean-up runs after a failure too: a refused import must not leave its wheels in the
    // store. The caller reports the outcome only after this, so "switched" also means "idle again".
    if (!lock.lost()) {
      if (staging) await removeFromState(context.layout, lock, staging).catch(() => {});
      if (checkout) await removeFromState(context.layout, lock, checkout.staging).catch(() => {});
      await tidy(context, lock);
    }
    await lock.release();
  }
}

/** Read a rebuild plan from preserved wheel bytes, before starting any installer. */
async function replayPlan(
  context: FlowContext,
  old: GenerationRecord,
  facts: BundleFacts
): Promise<{ targets: string[]; links: string }> {
  const roots = new Set(Object.values(old.extensions).map((entry) => entry.distribution));
  const targets = [];
  const links = new Set<string>();
  for (const name of roots) {
    const origin = old.distributions[name]?.origin;
    // A bundle upgrade is not consent to fetch an index or a repository again.
    if (origin?.kind !== 'file') throw new ExtensionFailure('BUNDLE_CHANGED');
    // oxlint-disable-next-line no-await-in-loop -- verify one wheel set at a time
    const set = await readStoredImport(context.layout, origin);
    if (!set) throw new ExtensionFailure('BUNDLE_CHANGED');
    const files = Object.keys(set.digests).map((wheel) => path.join(set.directory, wheel));
    // oxlint-disable-next-line no-await-in-loop -- same static checks as a normal offline import
    const check = await checkImport(set.target, files, facts);
    if (
      check.problems.length > 0 ||
      check.target?.name !== name ||
      check.target.version !== old.distributions[name].version
    )
      throw new ExtensionFailure('BUNDLE_CHANGED');
    targets.push(set.target);
    links.add(pathToFileURL(set.directory).href);
  }
  return { targets, links: [...links].join(' ') };
}

function assertSafeScan(scan: Awaited<ReturnType<typeof scanGeneration>>): SiteSnapshot {
  if (scan.problems.length > 0)
    throw new ExtensionFailure(
      scan.problems[0].code,
      scan.problems.map((problem) => problem.message)
    );
  return scan.snapshot;
}

async function verifyReboundCandidate(
  context: FlowContext,
  candidate: Candidate,
  old: GenerationRecord,
  facts: BundleFacts,
  replay?: Awaited<ReturnType<typeof replayPlan>>
): Promise<GenerationRecord> {
  const { bundle, layout, platform } = context;
  const env = managementEnvironment(context.base, platform, {
    agentDirectory: candidate.paths.agent,
    nativeSite: bundle.nativeSite,
    constraintsUrl: await writeConstraints(layout, bundle, facts),
    offlineLinksUrl: replay?.links || undefined,
  });
  let snapshot = assertSafeScan(await scanGeneration(candidate, facts, replay !== undefined));
  for (const target of replay?.targets ?? []) {
    /* oxlint-disable no-await-in-loop -- each install must pass its scan before another interpreter starts */
    const installer = await runManagement(
      context,
      candidate,
      env,
      ['--offline', 'extension', 'install', target, '--yes'],
      context.timeouts.installerMs
    );
    requireSuccess(installer, { 1: 'INSTALLER_FAILED', 2: 'INSTALLER_NOT_RUN' }, 'the installer', [
      0,
      INSTALLED_NOT_BOUND,
    ]);
    snapshot = assertSafeScan(await scanGeneration(candidate, facts));
    /* oxlint-enable no-await-in-loop */
  }
  const expected: ExpectedExtensions = new Map();
  for (const [name, entry] of Object.entries(old.extensions)) {
    const actual = snapshot.extensions.get(name);
    if (
      actual?.reference !== entry.reference ||
      actual.distribution !== entry.distribution ||
      !Object.hasOwn(old.distributions, entry.distribution) ||
      snapshot.distributions.get(entry.distribution)?.version !== old.distributions[entry.distribution].version
    )
      throw new ExtensionFailure('REQUEST_MISMATCH', [`the new runtime did not preserve extension ${name}`]);
    expected.set(name, entry.reference);
  }
  if (expected.size !== snapshot.extensions.size) throw new ExtensionFailure('REQUEST_MISMATCH');
  const distributions: GenerationRecord['distributions'] = Object.create(null);
  for (const { name, version, recordSha256 } of contentDistributions(snapshot)) {
    const prior = old.distributions[name];
    if (!replay && prior?.version !== version) throw new ExtensionFailure('GENERATION_MODIFIED');
    const origin = prior?.version === version ? prior.origin : undefined;
    distributions[name] = { version, recordSha256, ...(origin ? { origin } : {}) };
  }
  if (!replay && Object.keys(distributions).length !== Object.keys(old.distributions).length)
    throw new ExtensionFailure('GENERATION_MODIFIED');
  // Import alone can miss a dependency used only after setup. Ask pip to check the installed
  // metadata using both the new bundle and the candidate on its search path.
  const dependencies = await runToExit(
    context.spawn,
    {
      command: candidate.paths.python,
      args: ['-P', '-B', '-m', 'pip', 'check'],
      env,
      cwd: candidate.paths.directory,
    },
    { timeoutMs: context.timeouts.verifyMs, signal: context.signal }
  );
  requireSuccess(dependencies, { 1: 'VERIFICATION_FAILED' }, 'the dependency check');
  const verified = await verifyCandidate(context, candidate, env, snapshot, expected);
  return describeCandidate(context, candidate, old, old.operation, distributions, snapshot, verified, new Date());
}

/** Try to move a whole generation to the current bundle. The old generation stays intact. */
async function rebind(
  context: FlowContext,
  lock: MutationLock,
  base: PointerState,
  old: GenerationRecord
): Promise<GenerationRecord | undefined> {
  const facts = await readBundleFacts(context.bundle);
  const current = context.bundle.binding;
  const canCopy = old.binding.target === current.target && old.binding.pythonMinor === current.pythonMinor;
  for (const copy of canCopy ? [true, false] : [false]) {
    const id = generationId((base.pointer?.revision ?? 0) + 1, randomBytes(2).toString('hex'));
    let preparing = false;
    /* oxlint-disable no-await-in-loop -- copy first, then an independent empty candidate for replay */
    try {
      const replay = copy ? undefined : await replayPlan(context, old, facts);
      preparing = true;
      if (copy) {
        const site = generationPaths(context.layout, old.generation, old.binding.pythonMinor, context.platform).site;
        const original = contentDistributions(await readSite(site));
        if (
          original.length !== Object.keys(old.distributions).length ||
          original.some((dist) => old.distributions[dist.name]?.recordSha256 !== dist.recordSha256)
        )
          throw new ExtensionFailure('GENERATION_MODIFIED');
      }
      const candidate = await createCandidate(context, id, copy ? old : null, copy);
      return await verifyReboundCandidate(context, candidate, old, facts, replay);
    } catch (error) {
      if (lock.lost()) throw outcome(error, lock);
      if (preparing && (error as NodeJS.ErrnoException).code !== 'EEXIST') await lock.remove(`generations/${id}`);
      if (context.signal?.aborted || !(error instanceof ExtensionFailure)) throw error;
    }
    /* oxlint-enable no-await-in-loop */
  }
  return undefined;
}

async function switchRebound(
  context: FlowContext,
  lock: MutationLock,
  base: PointerState,
  old: GenerationRecord
): Promise<GenerationRecord | undefined> {
  const guarded = underLock(context, lock);
  const record = await rebind(guarded, lock, base, old);
  if (!record) return undefined;
  try {
    await commitCandidate(guarded, lock, base, record);
  } catch (error) {
    if (!(await inEffect(context.layout, record.generation)))
      await lock.remove(`generations/${record.generation}`).catch(() => {});
    throw outcome(error, lock);
  }
  await tidy(guarded, lock);
  return record;
}

/** Startup hook for the helper owner. A failed move keeps the old pointer and its reinstall status. */
export async function reconcileBundle(context: FlowContext): Promise<ExtensionListing> {
  await verifyLayout(context.layout);
  const current = await readPointer(context.layout);
  if (!current.record || sameBinding(current.record.binding, context.bundle.binding)) return describe(context);
  const { lock, base } = await begin(context);
  try {
    if (base.record && !sameBinding(base.record.binding, context.bundle.binding))
      await switchRebound(context, lock, base, base.record);
    return await describe(context);
  } finally {
    await lock.release();
  }
}

/**
 * Go back one step (ADR 5.7): make the previous generation current. The pointer is read
 * after the lock is taken, never before. When the previous generation belongs to another
 * bundle, move it into a new, verified generation before switching.
 */
export async function rollback(context: FlowContext): Promise<ExtensionRollback> {
  const { lock, base } = await begin(context);
  try {
    const target = base.pointer?.previous
      ? await readGenerationRecord(context.layout, base.pointer.previous)
      : undefined;
    if (!base.pointer || !target)
      throw new ExtensionFailure('NOTHING_TO_ROLL_BACK', ['there is no previous generation']);
    if (!sameBinding(target.binding, context.bundle.binding)) {
      const record = await switchRebound(context, lock, base, target);
      if (!record) throw new ExtensionFailure('BUNDLE_CHANGED', ['the previous generation did not fit the new bundle']);
      return { current: record.generation, previous: base.pointer.generation, revision: base.pointer.revision + 1 };
    }
    if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
    const next = newPointer(
      target.generation,
      base.pointer.generation,
      base.pointer.revision + 1,
      target.binding,
      retainedDefaults(base, target)
    );
    await switchPointer(context.layout, next, base.pointer, lock);
    await tidy(context, lock);
    return { current: next.generation, previous: next.previous, revision: next.revision };
  } catch (error) {
    throw outcome(error, lock);
  } finally {
    await lock.release();
  }
}

/** Update the current pointer's app defaults without changing the active generation or its rollback target. */
export async function setDefault(
  context: FlowContext,
  extensionId: string,
  enabled: boolean
): Promise<ExtensionListing> {
  const { lock, base } = await begin(context);
  try {
    const { pointer, record } = base;
    if (!pointer || !record?.launch.managed?.some(({ id }) => id === extensionId))
      throw new ExtensionFailure('NOT_INSTALLED', ['the managed extension is not in the current generation']);
    if (!sameBinding(record.binding, context.bundle.binding)) throw new ExtensionFailure('BUNDLE_CHANGED');
    if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
    if ((recordedDefault(pointer.defaults, extensionId) ?? true) !== enabled) {
      const defaults: NonNullable<typeof pointer.defaults> = Object.assign(Object.create(null), pointer.defaults);
      defaults[extensionId] = enabled;
      await switchPointer(context.layout, { ...pointer, defaults }, null, lock);
    }
    return await describe(context);
  } catch (error) {
    throw outcome(error, lock);
  } finally {
    await lock.release();
  }
}

/**
 * Change the user's extension settings: the fields of `change` replace the stored ones. Under
 * the mutation lock, like every other change, so a running install keeps the settings it
 * started with and two Studio processes cannot interleave a read and a write. When the stored
 * file could not be read, the change starts from the closed settings.
 *
 * Saved proxy credentials belong to one proxy: turning the proxy off, changing its scheme,
 * host or port, or turning `proxyAuthentication` off drops them. Credentials typed into the
 * proxy address turn `proxyAuthentication` on and replace saved ones: with a keychain they are
 * saved, without one the old ones are dropped too and the new ones are asked for at each
 * install. A new sealed file is written before the settings that name it and older ones are
 * removed after, so an interruption leaves settings whose credentials open; the next change
 * removes the file left over.
 *
 * @throws ExtensionFailure `INVALID_INPUT` for `proxyAuthentication` without a proxy
 */
export async function saveSettings(context: FlowContext, change: SettingsChange): Promise<StoredSettings> {
  const vault = context.proxyVault ?? MEMORY_ONLY_VAULT;
  const { lock } = await begin(context);
  try {
    const { layout } = context;
    const current = await readSettings(layout);
    const settings: ExtensionSettings = { ...current.settings, ...change.settings };
    const proxyChanged = settings.proxy !== current.settings.proxy;
    if (settings.proxy === null) {
      if (change.settings.proxyAuthentication === true)
        throw new ExtensionFailure('INVALID_INPUT', ['proxy authentication needs a proxy']);
      settings.proxyAuthentication = false;
    } else if (proxyChanged && change.settings.proxyAuthentication === undefined) settings.proxyAuthentication = false;
    if (change.credentials) settings.proxyAuthentication = true;
    // Credentials typed now replace saved ones; where nothing is kept, the old ones go too.
    let credentialId =
      proxyChanged || !settings.proxyAuthentication || change.credentials ? null : current.credentialId;
    if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
    if (change.credentials && settings.proxy !== null && vault.mode === 'keychain')
      credentialId = await saveProxyCredentials(layout, vault, settings.proxy, change.credentials, lock);
    await writeSettings(layout, settings, credentialId, lock);
    // Only now the older sealed files: interrupted before this, the settings still name one that opens.
    await dropProxyCredentials(layout, lock, credentialId);
    return { settings, unreadable: false, credentialId };
  } catch (error) {
    throw outcome(error, lock);
  } finally {
    await lock.release();
  }
}

/**
 * Save credentials for the current proxy in the keychain and turn `proxyAuthentication` on.
 *
 * @throws ExtensionFailure `PROXY_CREDENTIALS_NOT_STORED` without a keychain,
 * `SETTINGS_UNREADABLE` when the stored settings cannot be read, `INVALID_INPUT` without a proxy
 */
export async function setProxyCredentials(
  context: FlowContext,
  credentials: ProxyCredentials
): Promise<StoredSettings> {
  const vault = context.proxyVault ?? MEMORY_ONLY_VAULT;
  if (vault.mode !== 'keychain')
    throw new ExtensionFailure('PROXY_CREDENTIALS_NOT_STORED', ['proxy credentials are not kept here']);
  const { lock } = await begin(context);
  try {
    const current = await readSettings(context.layout);
    if (current.unreadable)
      throw new ExtensionFailure('SETTINGS_UNREADABLE', ['the extension settings cannot be read']);
    if (current.settings.proxy === null)
      throw new ExtensionFailure('INVALID_INPUT', ['set a proxy before its credentials']);
    if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
    const settings: ExtensionSettings = { ...current.settings, proxyAuthentication: true };
    const credentialId = await saveProxyCredentials(context.layout, vault, current.settings.proxy, credentials, lock);
    await writeSettings(context.layout, settings, credentialId, lock);
    await dropProxyCredentials(context.layout, lock, credentialId);
    return { settings, unreadable: false, credentialId };
  } catch (error) {
    throw outcome(error, lock);
  } finally {
    await lock.release();
  }
}

/** Drop saved proxy credentials. `proxyAuthentication` stays: the next install asks for them. */
export async function clearProxyCredentials(context: FlowContext): Promise<StoredSettings> {
  const { lock } = await begin(context);
  try {
    const current = await readSettings(context.layout);
    if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
    if (!current.unreadable && current.credentialId !== null)
      await writeSettings(context.layout, current.settings, null, lock);
    await dropProxyCredentials(context.layout, lock, null);
    return { ...current, credentialId: null };
  } catch (error) {
    throw outcome(error, lock);
  } finally {
    await lock.release();
  }
}

/**
 * What is installed, read from files only (ADR 5.10): no process is started and nothing
 * is contacted. Safe to call while a change is running; it shows the state before it.
 *
 * `ready` is reported only for an extension that passed the load check in the form new
 * conversations get it with its manifest bound (a pack, decision B5); one passed by module
 * reference loads but is `manifest_unbound`.
 */
export async function describe(
  context: Pick<FlowContext, 'bundle' | 'layout' | 'platform'>
): Promise<ExtensionListing> {
  await verifyLayout(context.layout);
  const { pointer, record } = await readPointer(context.layout);
  if (!pointer || !record)
    return {
      current: null,
      previous: null,
      revision: 0,
      appliesAt: 'next_adapter_start',
      rollbackAvailable: false,
      extensions: [],
    };
  const usable = sameBinding(record.binding, context.bundle.binding);
  const previous = pointer.previous ? await readGenerationRecord(context.layout, pointer.previous) : undefined;
  const managed = new Set(record.launch.managed?.map(({ id }) => id));
  return {
    current: pointer.generation,
    previous: pointer.previous,
    revision: pointer.revision,
    appliesAt: 'next_adapter_start',
    rollbackAvailable: previous !== undefined,
    extensions: Object.entries(record.extensions)
      .map(([name, extension]) => {
        const id = managedExtensionId(extension.distribution, name, extension.plugin);
        const origin = record.distributions[extension.distribution]?.origin;
        const source = usable ? upgradeSource(origin, extension.distribution) : undefined;
        let upgrade: ExtensionListing['extensions'][number]['upgrade'];
        if (source?.kind === 'index' && origin?.kind === 'index')
          upgrade = indexRequirement(source).exact
            ? 'pinned'
            : origin.requirement === undefined
              ? 'confirmation_required'
              : 'available';
        if (source?.kind === 'git' && origin?.kind === 'git' && context.platform !== 'win32')
          upgrade = pinnedGit(source, origin.commit) ? 'pinned' : 'available';
        return {
          name,
          distribution: extension.distribution,
          version: record.distributions[extension.distribution]?.version ?? '',
          reference: extension.reference,
          origin: origin ?? null,
          ...(upgrade ? { upgrade } : {}),
          ...(managed.has(id) ? { managedId: id, defaultEnabled: recordedDefault(pointer.defaults, id) ?? true } : {}),
          status: !usable
            ? ('reinstall_needed' as const)
            : extension.form === 'pack'
              ? ('ready' as const)
              : ('manifest_unbound' as const),
        };
      })
      .toSorted((left, right) => (left.name < right.name ? -1 : 1)),
  };
}
