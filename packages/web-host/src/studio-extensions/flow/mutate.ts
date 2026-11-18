import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { isAdapterReference } from '../inspect/metadata.js';
import { contentDistributions, readSite, type SiteSnapshot } from '../inspect/site.js';
import type { WheelFacts } from '../inspect/wheel.js';
import { runToExit, type RunResult } from '../process.js';
import { discardStage, promoteImport, stageImport, type ImportSet } from '../store/artifacts.js';
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
import { acquireMutationLock, type MutationLock } from '../store/lock.js';
import {
  newGenerationRecord,
  newPointer,
  readGenerationRecord,
  readPointer,
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
  type ExtensionSource,
} from '../types.js';
import {
  chooseForms,
  conversationReference,
  launchArguments,
  launchFormOf,
  loadedNames,
  writePacks,
  type ExtensionForm,
  type LaunchForm,
} from '../launch/form.js';
import { createCandidate, scanGeneration, type Candidate, type FlowContext } from './candidate.js';
import { managementEnvironment } from './environment.js';
import {
  compareRequest,
  nativeHandle,
  redactPaths,
  resolveDistribution,
  runLoadCheck,
  type ChangeRequest,
  type ExpectedExtensions,
  type LoadExpectation,
} from './gate.js';
import { checkImport } from './importCheck.js';

export type MutationRequest =
  | { action: 'install'; source: ExtensionSource }
  | { action: 'update'; name: string; source: ExtensionSource }
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
  timeoutMs: number
): Promise<RunResult> {
  return runToExit(
    context.spawn,
    {
      command: candidate.paths.python,
      args: ['-I', '-B', '-X', 'utf8', context.bundle.launcher, 'native', ...native],
      env,
      cwd: candidate.paths.directory,
    },
    { timeoutMs, signal: context.signal }
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

type Preparation = { change: ChangeRequest; native: string[]; importSet?: ImportSet; wheels: WheelFacts[] };

/** Work out what the request means against the current generation, and store an import. */
async function prepare(
  context: FlowContext,
  lock: MutationLock,
  request: MutationRequest,
  before: SiteSnapshot,
  bundle: BundleFacts
): Promise<Preparation> {
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

/** The record of a verified candidate: what it holds and where each distribution came from. */
function describeCandidate(
  context: FlowContext,
  candidate: Candidate,
  parent: GenerationRecord | null,
  request: MutationRequest,
  preparation: Preparation,
  snapshot: SiteSnapshot,
  bound: Map<string, boolean>,
  forms: Map<string, ExtensionForm>,
  launch: LaunchForm,
  createdAt: Date
): GenerationRecord {
  const imported = (name: string, version: string): ExtensionOrigin | undefined => {
    const wheel = preparation.wheels.find((facts) => facts.name === name && facts.version === version);
    const sha256 = wheel && preparation.importSet?.digests[wheel.filename];
    return preparation.importSet && wheel && sha256
      ? { kind: 'file', artifact: preparation.importSet.id, wheel: wheel.filename, sha256 }
      : undefined;
  };
  const distributions: Record<string, RecordedDistribution> = {};
  for (const { name, version, recordSha256 } of contentDistributions(snapshot)) {
    const inherited = parent?.distributions[name];
    // An untouched distribution keeps its origin; one this change wrote came from the import set.
    const untouched = inherited?.version === version && inherited.recordSha256 === recordSha256;
    const origin = untouched ? inherited.origin : imported(name, version);
    distributions[name] = { version, recordSha256, ...(origin ? { origin } : {}) };
  }
  return newGenerationRecord({
    generation: candidate.id,
    parent: parent?.generation ?? null,
    createdAt: createdAt.toISOString(),
    binding: context.bundle.binding,
    operation: {
      action: request.action,
      target: request.action === 'remove' ? request.name : preparation.change.distribution,
    },
    distributions,
    extensions: Object.fromEntries(
      [...snapshot.extensions].map(([name, extension]) => {
        const form = forms.get(name);
        return [
          name,
          {
            reference: extension.reference,
            distribution: extension.distribution,
            manifestBound: bound.get(name) ?? false,
            form: form?.form ?? 'module',
            plugin: form?.form === 'pack' ? form.plugin : null,
          },
        ];
      })
    ),
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

/** What ended a change under a lock: the loss of the lock outranks whatever it caused. */
function outcome(error: unknown, lock: MutationLock): unknown {
  return lock.lost() ? new ExtensionFailure('CONFLICT', ['the lock was lost while the change was in progress']) : error;
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
    if (base.record && !sameBinding(base.record.binding, bundle.binding))
      throw new ExtensionFailure('BUNDLE_CHANGED', ['the installed extensions belong to another Studio runtime']);
    const facts = await readBundleFacts(bundle);
    const before = base.record
      ? await readSite(generationPaths(layout, base.record.generation, base.record.binding.pythonMinor, platform).site)
      : EMPTY_SITE;
    const preparation = await prepare(guarded, lock, request, before, facts);

    hooks.progress('preparing');
    const constraintsUrl = await writeConstraints(layout, bundle, facts);
    const revision = base.pointer?.revision ?? 0;
    unfinished = generationId(revision + 1, hooks.suffix());
    const candidate = await createCandidate(guarded, unfinished, base.record);
    const refuse = (problems: { code: ExtensionFailureCode; message: string }[], output?: string): void => {
      if (problems.length > 0)
        throw new ExtensionFailure(
          problems[0].code,
          problems.map((problem) => problem.message),
          output
        );
    };
    refuse((await scanGeneration(candidate, facts)).problems);

    hooks.progress('installing');
    const management = { agentDirectory: candidate.paths.agent, nativeSite: bundle.nativeSite, constraintsUrl };
    const installer = await runManagement(
      guarded,
      candidate,
      managementEnvironment(guarded.base, platform, {
        ...management,
        ...(preparation.importSet ? { offlineLinksUrl: pathToFileURL(preparation.importSet.directory).href } : {}),
      }),
      preparation.native,
      guarded.timeouts.installerMs
    );
    // `extension remove` hands pip's own exit code through: there 2 and 3 are pip's, not
    // native's "did not run" and "not bound", so every non-zero code is a plain failure.
    if (request.action === 'remove') requireSuccess(installer, { 1: 'INSTALLER_FAILED' }, 'the installer');
    else
      requireSuccess(installer, { 1: 'INSTALLER_FAILED', 2: 'INSTALLER_NOT_RUN' }, 'the installer', [
        0,
        INSTALLED_NOT_BOUND,
      ]);
    // The candidate's interpreter is not started again unless this second scan passes.
    const scan = await scanGeneration(candidate, facts);
    refuse(scan.problems, installer.output);

    hooks.progress('verifying');
    const gate = compareRequest(preparation.change, before, scan.snapshot);
    if (!gate.changed) throw new ExtensionFailure('NO_CHANGE', ['nothing was installed or removed'], installer.output);
    if (gate.problems.length > 0) throw new ExtensionFailure('REQUEST_MISMATCH', gate.problems, installer.output);
    const bound = await manifestBindings(
      guarded,
      candidate,
      managementEnvironment(guarded.base, platform, management),
      gate.expected
    );
    // The installer's verdict stands even when `extension verify` does not repeat it.
    if (installer.code === INSTALLED_NOT_BOUND && [...bound.values()].every(Boolean))
      for (const [name, extension] of scan.snapshot.extensions)
        if (extension.distribution === preparation.change.distribution) bound.set(name, false);
    const forms = await chooseForms(guarded, candidate, scan.snapshot, gate.expected, bound);
    const launch = launchFormOf(gate.expected, forms);
    const unsupported = launch.modules.filter((reference) => !isAdapterReference(reference));
    if (unsupported.length > 0)
      throw new ExtensionFailure(
        'LOAD_ERROR',
        unsupported.map((reference) => `${reference} cannot be passed to a conversation by module reference`)
      );
    await writePacks(candidate, forms);
    // Every extension by reference, in the order conversations get them: imports each and runs
    // its setup() now, lazy pack or not. Without packs this is exactly what conversations get.
    const byReference = new Map(
      [...gate.expected].map(([name, reference]): [string, string] => [name, conversationReference(reference)])
    );
    const references = [...byReference.keys()].toSorted().map((name) => byReference.get(name) ?? '');
    await loadOrRefuse(guarded, candidate, references, byReference);
    // Then exactly the way new conversations get them, which binds the manifests of the packs.
    if (launch.packs)
      await loadOrRefuse(
        guarded,
        candidate,
        launchArguments(candidate.paths.directory, launch),
        loadedNames(gate.expected, forms)
      );

    const record = describeCandidate(
      guarded,
      candidate,
      base.record,
      request,
      preparation,
      scan.snapshot,
      bound,
      forms,
      launch,
      hooks.now()
    );
    await writeGenerationRecord(layout, record);
    // The lock is the first guard, the revision the second (ADR 5.6).
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
      newPointer(candidate.id, base.pointer?.generation ?? null, revision + 1, bundle.binding),
      base.pointer,
      lock
    );
    unfinished = undefined;
    return { generation: candidate.id, revision: revision + 1 };
  } catch (error) {
    // Without the lock nothing is removed; the next change under a lock removes what is left.
    if (unfinished !== undefined) await lock.remove(`generations/${unfinished}`).catch(() => {});
    throw outcome(error, lock);
  } finally {
    // Clean-up runs after a failure too: a refused import must not leave its wheels in the
    // store. The caller reports the outcome only after this, so "switched" also means "idle again".
    if (!lock.lost()) await tidy(context, lock);
    await lock.release();
  }
}

/**
 * Go back one step (ADR 5.7): make the previous generation current. The pointer is read
 * after the lock is taken, never before. A previous generation bound to another bundle
 * would have to be fitted to this one first, which is not part of this piece.
 */
export async function rollback(context: FlowContext): Promise<ExtensionRollback> {
  const { lock, base } = await begin(context);
  try {
    const target = base.pointer?.previous
      ? await readGenerationRecord(context.layout, base.pointer.previous)
      : undefined;
    if (!base.pointer || !target)
      throw new ExtensionFailure('NOTHING_TO_ROLL_BACK', ['there is no previous generation']);
    if (!sameBinding(target.binding, context.bundle.binding))
      throw new ExtensionFailure('BUNDLE_CHANGED', ['the previous generation belongs to another Studio runtime']);
    const next = newPointer(target.generation, base.pointer.generation, base.pointer.revision + 1, target.binding);
    await switchPointer(context.layout, next, base.pointer, lock);
    await tidy(context, lock);
    return { current: next.generation, previous: next.previous, revision: next.revision };
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
      appliesAt: 'new_session',
      rollbackAvailable: false,
      extensions: [],
    };
  const usable = sameBinding(record.binding, context.bundle.binding);
  const previous = pointer.previous ? await readGenerationRecord(context.layout, pointer.previous) : undefined;
  return {
    current: pointer.generation,
    previous: pointer.previous,
    revision: pointer.revision,
    appliesAt: 'new_session',
    rollbackAvailable: previous !== undefined && sameBinding(previous.binding, context.bundle.binding),
    extensions: Object.entries(record.extensions)
      .map(([name, extension]) => ({
        name,
        distribution: extension.distribution,
        version: record.distributions[extension.distribution]?.version ?? '',
        reference: extension.reference,
        origin: record.distributions[extension.distribution]?.origin ?? null,
        status: !usable
          ? ('reinstall_needed' as const)
          : extension.form === 'pack'
            ? ('ready' as const)
            : ('manifest_unbound' as const),
      }))
      .toSorted((left, right) => (left.name < right.name ? -1 : 1)),
  };
}
