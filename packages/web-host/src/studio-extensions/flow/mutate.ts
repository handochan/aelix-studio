import { pathToFileURL } from 'node:url';
import { isEntryName } from '../inspect/metadata.js';
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
import { createCandidate, discardCandidate, scanGeneration, type Candidate, type FlowContext } from './candidate.js';
import { managementEnvironment } from './environment.js';
import {
  compareRequest,
  resolveDistribution,
  runLoadCheck,
  type ChangeRequest,
  type ExpectedExtensions,
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

/** Turn the end of a helper child into a failure, or return when it exited with `0`. */
function requireSuccess(result: RunResult, codes: Record<number, ExtensionFailureCode>, what: string): void {
  if (result.cancelled) throw new ExtensionFailure('CANCELLED');
  if (result.timedOut) throw new ExtensionFailure('TIMEOUT', [`${what} took too long`], result.output);
  if (result.code === 0) return;
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
  request: MutationRequest,
  before: SiteSnapshot,
  bundle: BundleFacts
): Promise<Preparation> {
  const owner = request.action === 'install' ? undefined : resolveDistribution(before, request.name);
  // native resolves an entry name before a distribution name, so an entry name is unambiguous.
  const entry = [...before.extensions].find(([, extension]) => extension.distribution === owner)?.[0];
  if (request.action !== 'install' && (!owner || entry === undefined || !isEntryName(entry)))
    throw new ExtensionFailure('NOT_INSTALLED', [`no installed extension provides ${request.name}`]);
  if (request.action === 'remove')
    return {
      change: { action: 'remove', distribution: owner ?? '' },
      native: ['extension', 'remove', entry ?? '', '--yes'],
      wheels: [],
    };
  const staged = await stageImport(context.layout, request.source);
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
    const importSet = await promoteImport(context.layout, staged);
    return {
      change: { action: request.action, distribution: check.target.name, version: check.target.version },
      // A file import always runs offline: no index, wheels from the stored set only (ADR 5.9).
      native: ['--offline', 'extension', 'install', importSet.target, '--yes'],
      importSet,
      wheels: check.wheels,
    };
  } catch (error) {
    await discardStage(staged);
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
      [...snapshot.extensions].map(([name, extension]) => [
        name,
        {
          reference: extension.reference,
          distribution: extension.distribution,
          manifestBound: bound.get(name) ?? false,
        },
      ])
    ),
  });
}

/** Take the lock, undo interrupted work, read the pointer: the start of every change (ADR 5.6). */
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
    await recover(context.layout);
    return { lock, base: await readPointer(context.layout) };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

/** Clean-up under the lock. A failure here never changes the outcome of the change. */
async function tidy(context: FlowContext): Promise<void> {
  try {
    await collect({ bundle: context.bundle, layout: context.layout, spawn: context.spawn, env: context.base });
  } catch {
    // Left for the next change to clean up.
  }
}

/**
 * Install, update or remove an extension (D04 ADR 5.4). The change is made in a candidate
 * generation; the pointer moves only after the static scan, the installer, the comparison
 * of request and result and the load check all passed. On any failure the candidate is
 * removed and the current generation is untouched.
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
  try {
    const { bundle, layout, platform } = context;
    if (base.record && !sameBinding(base.record.binding, bundle.binding))
      throw new ExtensionFailure('BUNDLE_CHANGED', ['the installed extensions belong to another Studio runtime']);
    const facts = await readBundleFacts(bundle);
    const before = base.record
      ? await readSite(generationPaths(layout, base.record.generation, base.record.binding.pythonMinor, platform).site)
      : EMPTY_SITE;
    const preparation = await prepare(context, request, before, facts);

    hooks.progress('preparing');
    const constraintsUrl = await writeConstraints(layout, bundle, facts);
    const revision = base.pointer?.revision ?? 0;
    const candidate = await createCandidate(context, generationId(revision + 1, hooks.suffix()), base.record);
    try {
      const refuse = (problems: { code: ExtensionFailureCode; message: string }[], output?: string): void => {
        if (problems.length > 0)
          throw new ExtensionFailure(
            problems[0].code,
            problems.map((problem) => problem.message),
            output
          );
      };
      refuse((await scanGeneration(context, candidate, facts)).problems);

      hooks.progress('installing');
      const management = { agentDirectory: candidate.paths.agent, nativeSite: bundle.nativeSite, constraintsUrl };
      const installer = await runManagement(
        context,
        candidate,
        managementEnvironment(context.base, platform, {
          ...management,
          ...(preparation.importSet ? { offlineLinksUrl: pathToFileURL(preparation.importSet.directory).href } : {}),
        }),
        preparation.native,
        context.timeouts.installerMs
      );
      requireSuccess(
        installer,
        { 1: 'INSTALLER_FAILED', 2: 'INSTALLER_NOT_RUN', 3: 'MANIFEST_UNBOUND' },
        'the installer'
      );
      // The candidate's interpreter is not started again unless this second scan passes.
      const scan = await scanGeneration(context, candidate, facts);
      refuse(scan.problems, installer.output);

      hooks.progress('verifying');
      const gate = compareRequest(preparation.change, before, scan.snapshot);
      if (!gate.changed)
        throw new ExtensionFailure('NO_CHANGE', ['nothing was installed or removed'], installer.output);
      if (gate.problems.length > 0) throw new ExtensionFailure('REQUEST_MISMATCH', gate.problems, installer.output);
      const bound = await manifestBindings(
        context,
        candidate,
        managementEnvironment(context.base, platform, management),
        gate.expected
      );
      const load = await runLoadCheck(context, candidate, gate.expected);
      if (load.cancelled) throw new ExtensionFailure('CANCELLED');
      if (load.timedOut) throw new ExtensionFailure('TIMEOUT', ['the load check took too long']);
      if (!load.answered) throw new ExtensionFailure('VERIFICATION_FAILED', load.problems);
      if (load.problems.length > 0) throw new ExtensionFailure('LOAD_ERROR', load.problems);

      const record = describeCandidate(
        context,
        candidate,
        base.record,
        request,
        preparation,
        scan.snapshot,
        bound,
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
        base.pointer
      );
    } catch (error) {
      await discardCandidate(candidate);
      throw error;
    }
    return { generation: candidate.id, revision: revision + 1 };
  } finally {
    // Clean-up runs after a failure too: a refused import must not leave its wheels in the
    // store. The caller reports the outcome only after this, so "switched" also means "idle again".
    if (!lock.lost()) await tidy(context);
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
    if (lock.lost()) throw new ExtensionFailure('CONFLICT', ['the lock was lost']);
    const next = newPointer(target.generation, base.pointer.generation, base.pointer.revision + 1, target.binding);
    await switchPointer(context.layout, next, base.pointer);
    await tidy(context);
    return { current: next.generation, previous: next.previous, revision: next.revision };
  } finally {
    await lock.release();
  }
}

/**
 * What is installed, read from files only (ADR 5.10): no process is started and nothing
 * is contacted. Safe to call while a change is running; it shows the state before it.
 */
export async function describe(context: Pick<FlowContext, 'bundle' | 'layout'>): Promise<ExtensionListing> {
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
          : extension.manifestBound
            ? ('ready' as const)
            : ('manifest_unbound' as const),
      }))
      .toSorted((left, right) => (left.name < right.name ? -1 : 1)),
  };
}
