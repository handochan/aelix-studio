import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAdapterReference } from '../inspect/metadata.js';
import { contentDistributions, readSite, type SiteSnapshot } from '../inspect/site.js';
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
import { checkoutSubdirectory, type GitCheckout } from './online/checkout.js';
import { privateGitAccess } from './online/credentials.js';
import {
  dropProxyCredentials,
  MEMORY_ONLY_VAULT,
  openSavedCredentials,
  proxyWithCredentials,
  saveProxyCredentials,
} from './online/proxyCredentials.js';
import { readSettings, writeSettings, type SettingsChange, type StoredSettings } from './online/settings.js';
import { installedCheckoutOrigin, installedGitOrigin, matchesVersion, onlineIndex } from './online/source.js';

export type MutationRequest =
  | {
      action: 'install';
      source: ExtensionSource;
      replaceIncompatible?: boolean;
      /** For this install only; never stored. */
      proxyCredentials?: ProxyCredentials;
    }
  | { action: 'update'; name: string; source: FileExtensionSource }
  | { action: 'remove'; name: string };

export type MutationHooks = {
  progress(phase: Extract<ExtensionPhase, 'checking' | 'preparing' | 'installing' | 'verifying'>): void;
  /** Four hex characters that make a generation name unique. */
  suffix(): string;
  now(): Date;
};

export type MutationOutcome = { generation: string; revision: number };

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
    { timeoutMs, signal: context.signal, redact: true }
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
type OnlineInstaller = Installer & { source: OnlineExtensionSource };

/** Work out what the request means against the current generation, and store an import. */
async function prepare(
  context: FlowContext,
  lock: MutationLock,
  request: MutationRequest,
  before: SiteSnapshot,
  bundle: BundleFacts
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
  if (request.source.kind !== 'file') {
    const source = request.source;
    const native = ['extension', 'install'];
    if (source.kind === 'index') {
      native.push(source.version === undefined ? source.name : `${source.name}==${source.version}`);
      // A flag also prevents native from falling back to registered extra indexes.
      native.push('--index-url', onlineIndex(source));
    } else native.push(source.url);
    return { native: [...native, '--yes'], source, wheels: [] };
  }
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
 * The proxy URL an online install gives pip and Git: the stored proxy, with the credentials of
 * the request or the saved ones as its user part when the proxy asks for them. They go into
 * the installer environment only, never into an argument.
 *
 * @throws ExtensionFailure `PROXY_CREDENTIALS_REQUIRED` when the proxy asks for credentials
 * and none are at hand; `INVALID_INPUT` for credentials sent without a proxy
 */
async function installProxy(
  context: FlowContext,
  stored: StoredSettings,
  supplied: ProxyCredentials | undefined
): Promise<string | undefined> {
  const { proxy, proxyAuthentication } = stored.settings;
  const vault = context.proxyVault ?? MEMORY_ONLY_VAULT;
  if (proxy === null) {
    if (supplied) throw new ExtensionFailure('INVALID_INPUT', ['proxy credentials were sent, but no proxy is set']);
    return undefined;
  }
  const credentials =
    supplied ??
    (proxyAuthentication ? await openSavedCredentials(context.layout, vault, proxy, stored.credentialId) : undefined);
  if (proxyAuthentication && !credentials)
    throw new ExtensionFailure('PROXY_CREDENTIALS_REQUIRED', [
      vault.mode === 'memory-only'
        ? 'proxy credentials are not kept here; send them with the install'
        : 'no saved proxy credentials could be opened; send them with the install or save them again',
    ]);
  return credentials ? proxyWithCredentials(proxy, credentials) : proxy;
}

/** The record of a verified candidate: what it holds and where each distribution came from. */
function describeMutation(
  context: FlowContext,
  candidate: Candidate,
  parent: GenerationRecord | null,
  request: MutationRequest,
  preparation: Preparation,
  snapshot: SiteSnapshot,
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
    const untouched = inherited?.version === version && inherited.recordSha256 === recordSha256;
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
  try {
    const { bundle, layout, platform } = guarded;
    const stale = base.record && !sameBinding(base.record.binding, bundle.binding);
    if (stale && !(request.action === 'install' && request.replaceIncompatible))
      throw new ExtensionFailure('BUNDLE_CHANGED', ['the installed extensions belong to another Studio runtime']);
    // The settings this change uses: read once, under the lock, so none of them moves until it ends.
    const stored = await readSettings(layout);
    const { settings, unreadable } = stored;
    let proxy: string | undefined;
    if (request.action === 'install' && request.source.kind !== 'file') {
      if (unreadable) throw new ExtensionFailure('SETTINGS_UNREADABLE', ['the extension settings cannot be read']);
      if (!settings.onlineInstall) throw new ExtensionFailure('ONLINE_INSTALL_DISABLED');
      proxy = await installProxy(guarded, stored, request.proxyCredentials);
    }
    // A confirmed reinstall starts fresh and keeps the old record as the previous generation.
    const parent = stale ? null : base.record;
    const facts = await readBundleFacts(bundle);
    const before = parent
      ? await readSite(generationPaths(layout, parent.generation, parent.binding.pythonMinor, platform).site)
      : EMPTY_SITE;
    const prepared = await prepare(guarded, lock, request, before, facts);
    const source = 'source' in prepared ? prepared.source : undefined;
    const offlineImport = prepared.importSet !== undefined;

    hooks.progress('preparing');
    const constraintsUrl = await writeConstraints(layout, bundle, facts);
    const revision = base.pointer?.revision ?? 0;
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
    refuse((await scanGeneration(candidate, facts, offlineImport)).problems);

    hooks.progress('installing');
    const management = { agentDirectory: candidate.paths.agent, nativeSite: bundle.nativeSite, constraintsUrl };
    // native treats an existing relative path as a local install, even when it looks like a package name.
    const cwd = source ? path.join(candidate.paths.directory, 'install-work') : candidate.paths.directory;
    const home = path.join(candidate.paths.directory, 'install-home');
    if (source) await Promise.all([mkdir(cwd), mkdir(home, { mode: 0o700 })]);
    const installerEnvironment = managementEnvironment(guarded.base, platform, {
      ...management,
      ...(prepared.importSet ? { offlineLinksUrl: pathToFileURL(prepared.importSet.directory).href } : {}),
      ...(source
        ? {
            online: {
              indexUrl: onlineIndex(source),
              home,
              work: cwd,
              access: await onlineAccess(guarded, settings, proxy, source, home),
            },
          }
        : {}),
    });
    let native = prepared.native;
    let checkout: GitCheckout | undefined;
    if (source?.kind === 'git' && source.subdirectory !== undefined) {
      // Studio fetches and checks the subdirectory; native installs a checked copy of it.
      checkout = await checkoutSubdirectory(
        guarded,
        lock,
        installerEnvironment,
        { ...source, subdirectory: source.subdirectory },
        guarded.timeouts.installerMs
      );
      native = ['extension', 'install', checkout.directory, '--yes'];
    }
    let installer: RunResult;
    try {
      installer = await runManagement(
        guarded,
        candidate,
        installerEnvironment,
        native,
        guarded.timeouts.installerMs,
        cwd
      );
    } finally {
      // The installed files are in the venv now; the lock holder removes the sources.
      if (checkout) await removeFromState(layout, lock, checkout.staging);
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
        ? await installedCheckoutOrigin(prepared.source, candidate.paths.site, before, scan.snapshot, checkout)
        : await installedGitOrigin(prepared.source, candidate.paths.site, before, scan.snapshot);
      preparation = { ...prepared, change: { action: 'install', distribution } };
      onlineOrigin = origin;
    } else {
      const { name, version } = prepared.source;
      preparation = { ...prepared, change: { action: 'install', distribution: name, version, matchesVersion } };
      if (before.distributions.get(name)?.recordSha256 !== scan.snapshot.distributions.get(name)?.recordSha256)
        onlineOrigin = { kind: 'index', indexUrl: onlineIndex(prepared.source) };
    }
    const gate = compareRequest(preparation.change, before, scan.snapshot);
    if (!gate.changed) throw new ExtensionFailure('NO_CHANGE', ['nothing was installed or removed'], installer.output);
    if (gate.problems.length > 0) throw new ExtensionFailure('REQUEST_MISMATCH', gate.problems, installer.output);
    const { bound, forms, launch } = await verifyCandidate(
      guarded,
      candidate,
      managementEnvironment(guarded.base, platform, management),
      scan.snapshot,
      gate.expected,
      installer.code === INSTALLED_NOT_BOUND ? preparation.change.distribution : undefined
    );

    const record = describeMutation(
      guarded,
      candidate,
      parent,
      request,
      preparation,
      scan.snapshot,
      bound,
      forms,
      launch,
      hooks.now(),
      onlineOrigin
    );
    await commitCandidate(guarded, lock, base, record);
    unfinished = undefined;
    return { generation: candidate.id, revision: revision + 1 };
  } catch (error) {
    // Without the lock nothing is removed; the next change under a lock removes what is left.
    // A switch can fail after its rename took effect (flushing the directory, say): then the
    // candidate is in effect, and a launcher may already use it. It stays.
    if (unfinished !== undefined && !(await inEffect(context.layout, unfinished)))
      await lock.remove(`generations/${unfinished}`).catch(() => {});
    throw outcome(error, lock);
  } finally {
    // Clean-up runs after a failure too: a refused import must not leave its wheels in the
    // store. The caller reports the outcome only after this, so "switched" also means "idle again".
    if (!lock.lost()) await tidy(context, lock);
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
    if (!replay && (prior?.version !== version || prior.recordSha256 !== recordSha256))
      throw new ExtensionFailure('GENERATION_MODIFIED');
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
 * Saved proxy credentials belong to one proxy: turning the proxy off, changing its host or
 * port, or turning `proxyAuthentication` off drops them. Credentials typed into the proxy
 * address turn `proxyAuthentication` on and, with a keychain, are saved; without one they are
 * dropped here and asked for at each install.
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
    if (change.credentials && settings.proxy !== null) settings.proxyAuthentication = true;
    let credentialId = proxyChanged || !settings.proxyAuthentication ? null : current.credentialId;
    if (context.signal?.aborted) throw new ExtensionFailure('CANCELLED');
    if (change.credentials && settings.proxy !== null && vault.mode === 'keychain')
      credentialId = await saveProxyCredentials(layout, vault, settings.proxy, change.credentials, lock);
    await writeSettings(layout, settings, credentialId, lock);
    // No id, no sealed file: this also removes one left by unreadable settings or an interrupted save.
    if (credentialId === null) await dropProxyCredentials(layout, lock);
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
    await dropProxyCredentials(context.layout, lock);
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
export async function describe(context: Pick<FlowContext, 'bundle' | 'layout'>): Promise<ExtensionListing> {
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
        return {
          name,
          distribution: extension.distribution,
          version: record.distributions[extension.distribution]?.version ?? '',
          reference: extension.reference,
          origin: record.distributions[extension.distribution]?.origin ?? null,
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
