import { isEntryName, isObjectReference, nativeName } from '../inspect/metadata.js';
import {
  contentDistributions,
  type InstalledDistribution,
  type InstalledExtension,
  type SiteSnapshot,
} from '../inspect/site.js';
import { redactUrlCredentials, runToExit } from '../process.js';
import type { Candidate, FlowContext } from './candidate.js';
import { loadEnvironment } from './environment.js';
import type { ManagedEntry } from '../launch/managedCatalog.js';
import { ExtensionFailure } from '../types.js';

/** What a change asked for, in terms the result can be checked against. */
export type ChangeRequest =
  | {
      action: 'install' | 'update';
      distribution: string;
      version?: string;
      matchesVersion?: (pin: string, installed: string) => boolean;
    }
  | { action: 'remove'; distribution: string };

/** Extension entry name to object reference: the set that must load, no more and no less. */
export type ExpectedExtensions = Map<string, string>;

export type GateResult = {
  problems: string[];
  /** False when no distribution was added, removed or rewritten. */
  changed: boolean;
  expected: ExpectedExtensions;
};

const same = (left: InstalledDistribution | undefined, right: InstalledDistribution | undefined): boolean =>
  left !== undefined &&
  right !== undefined &&
  left.version === right.version &&
  left.recordSha256 === right.recordSha256;

/** Entry names of the extensions a distribution provides. */
const owned = (snapshot: SiteSnapshot, distribution: string): string[] =>
  [...snapshot.extensions].filter(([, extension]) => extension.distribution === distribution).map(([name]) => name);

export type Resolution = { distribution: string } | { ambiguous: string[] };

/**
 * The distribution a name refers to in a snapshot, or the names it could mean when it fits
 * more than one distribution; undefined when nothing fits.
 *
 * An exact extension entry name wins. Otherwise names are compared the way native compares
 * them (case and `_`/`-` fold, a dot does not) with the entry names and with the names of
 * distributions that provide an extension. A name that fits more than one distribution that
 * way is ambiguous: native would take whichever it happens to list first.
 */
export function resolveDistribution(snapshot: SiteSnapshot, name: string): Resolution | undefined {
  const exact = snapshot.extensions.get(name);
  if (exact) return { distribution: exact.distribution };
  const wanted = nativeName(name);
  const fits: [string, string][] = [
    ...[...snapshot.extensions]
      .filter(([entry]) => nativeName(entry) === wanted)
      .map(([entry, extension]): [string, string] => [entry, extension.distribution]),
    ...[...snapshot.distributions.values()]
      .filter((distribution) => nativeName(distribution.declaredName) === wanted)
      .filter((distribution) => owned(snapshot, distribution.name).length > 0)
      .map((distribution): [string, string] => [distribution.declaredName, distribution.name]),
  ];
  const owners = new Set(fits.map(([, distribution]) => distribution));
  if (owners.size > 1) return { ambiguous: fits.map(([fit]) => fit) };
  return owners.size === 1 ? { distribution: fits[0][1] } : undefined;
}

/**
 * A name to hand to native (`extension remove <name>`) that it resolves to `distribution`
 * whatever order it lists extensions in. native takes the first entry name that fits, then
 * the first distribution name. Returns undefined when every name of the distribution could
 * also mean another one.
 */
export function nativeHandle(snapshot: SiteSnapshot, distribution: string): string | undefined {
  const entries = [...snapshot.extensions];
  const fits = (name: string): [string, InstalledExtension][] =>
    entries.filter(([entry]) => nativeName(entry) === nativeName(name));
  for (const name of owned(snapshot, distribution))
    if (isEntryName(name) && fits(name).every(([, extension]) => extension.distribution === distribution)) return name;
  const declared = snapshot.distributions.get(distribution)?.declaredName;
  return declared !== undefined && isEntryName(declared) && fits(declared).length === 0 ? declared : undefined;
}

/**
 * Compare a request with its result (D04 ADR 5.5) and derive the extension set that must
 * load. An installer that exits 0 has not thereby done what was asked: a wheel without an
 * entry point installs cleanly and would otherwise pass an empty verification.
 *
 * The expected set is mandatory. It is empty only after the last extension was removed.
 */
export function compareRequest(request: ChangeRequest, before: SiteSnapshot, after: SiteSnapshot): GateResult {
  const problems: string[] = [...after.problems];
  const [was, now] = [before.distributions, after.distributions];
  const beforeNames = contentDistributions(before).map((distribution) => distribution.name);
  const afterNames = contentDistributions(after).map((distribution) => distribution.name);
  const altered = new Set(afterNames.filter((name) => !same(was.get(name), now.get(name))));
  const gone = beforeNames.filter((name) => !now.has(name));
  const changed = altered.size > 0 || gone.length > 0;
  const expected: ExpectedExtensions = new Map();

  if (request.action === 'remove') {
    if (now.has(request.distribution)) problems.push(`${request.distribution} is still installed`);
    for (const name of owned(after, request.distribution)) problems.push(`extension ${name} is still present`);
    for (const name of gone) if (name !== request.distribution) problems.push(`distribution ${name} disappeared`);
    for (const name of altered) problems.push(`distribution ${name} was added or changed`);
    for (const [name, extension] of before.extensions)
      if (extension.distribution !== request.distribution) expected.set(name, extension.reference);
  } else {
    const installed = now.get(request.distribution);
    if (!installed) problems.push(`the requested distribution ${request.distribution} is not in the candidate`);
    else if (
      request.version !== undefined &&
      !(request.matchesVersion
        ? request.matchesVersion(request.version, installed.version)
        : installed.version === request.version)
    )
      problems.push(`${request.distribution} is ${installed.version}, the request was ${request.version}`);
    if (owned(after, request.distribution).length === 0)
      problems.push(`${request.distribution} provides no aelix.extensions entry point`);
    for (const name of gone) problems.push(`distribution ${name} disappeared`);
    // Extensions of untouched distributions stay; those of added or rewritten ones are taken from the result.
    for (const [name, extension] of before.extensions) {
      if (!altered.has(extension.distribution) && now.has(extension.distribution))
        expected.set(name, extension.reference);
      // Installing one extension must not take another away, even one whose distribution was rewritten.
      if (extension.distribution !== request.distribution && !after.extensions.has(name))
        problems.push(`extension ${name} was lost`);
    }
    for (const [name, extension] of after.extensions)
      if (altered.has(extension.distribution)) expected.set(name, extension.reference);
  }

  const actual = new Map([...after.extensions].map(([name, extension]) => [name, extension.reference]));
  for (const [name, reference] of expected)
    if (actual.get(name) !== reference) problems.push(`extension ${name} is missing or points elsewhere`);
  for (const [name, reference] of actual) {
    if (!expected.has(name)) problems.push(`unexpected extension ${name}`);
    if (!isEntryName(name) || !isObjectReference(reference))
      problems.push(`extension ${name} has no usable name or object reference`);
  }
  return { problems, changed, expected };
}

/**
 * Arguments of the conversation launch form (ADR 5.2) for a generation: the bundled
 * interpreter with `-I -S`, the bundle's own `launch.py`, which puts the generation's
 * site-packages last on the import path in its `native-generation` mode, exactly as the
 * launcher does for a conversation.
 */
export function conversationArguments(context: FlowContext, candidate: Candidate, native: string[]): string[] {
  return [
    '-I',
    '-S',
    '-B',
    '-X',
    'utf8',
    context.bundle.launcher,
    'native-generation',
    candidate.paths.site,
    ...native,
  ];
}

const REQUEST_ID = 'studio-extension-load-check';

type ResourceReply = {
  id?: unknown;
  success?: unknown;
  data?: { extensions?: { name?: unknown }[]; extensionErrors?: { source?: unknown; message?: unknown }[] };
};

/** Entry name of each extension that has to load, to the name native reports it under. */
export type LoadExpectation = Map<string, string>;

/** Problems in a `resources/list` reply, given the extensions that had to load. */
export function checkLoaded(expected: LoadExpectation, reply: ResourceReply | undefined): string[] {
  if (!reply || reply.success !== true || typeof reply.data !== 'object' || reply.data === null)
    return ['native did not answer resources/list'];
  const errors = Array.isArray(reply.data.extensionErrors) ? reply.data.extensionErrors : [];
  const problems = errors.map((error) => `load error ${String(error.source)}: ${String(error.message)}`);
  const loaded = new Set(
    (Array.isArray(reply.data.extensions) ? reply.data.extensions : []).map((entry) => entry.name)
  );
  for (const [name, reported] of expected)
    if (!loaded.has(reported) && !errors.some((error) => error.source === reported))
      problems.push(`${name} (${reported}) is not in the loaded list`);
  return problems;
}

export type LoadCheck = { problems: string[]; answered: boolean; cancelled: boolean; timedOut: boolean };

/** Run the exact ACP module provenance check with the bundled native interpreter. */
export async function verifyManagedCatalog(
  context: FlowContext,
  candidate: Candidate,
  catalogue: ManagedEntry[]
): Promise<void> {
  const result = await runToExit(
    context.spawn,
    {
      command: context.bundle.python,
      args: ['-I', '-S', '-B', '-X', 'utf8', context.bundle.launcher, 'verify-managed', candidate.paths.site],
      env: loadEnvironment(context.base, candidate.paths.agent),
      cwd: candidate.paths.directory,
    },
    {
      timeoutMs: context.timeouts.verifyMs,
      signal: context.signal,
      input: JSON.stringify({ generation: candidate.id, catalogue }) + '\n',
    }
  );
  if (result.cancelled) throw new ExtensionFailure('CANCELLED');
  if (result.timedOut) throw new ExtensionFailure('TIMEOUT', ['the managed extension verification took too long']);
  const line = result.output.split('\n').findLast((value) => value.startsWith('{"managedVerification":'));
  let reply: { managedVerification?: boolean; reason?: unknown } | undefined;
  try {
    if (line) reply = JSON.parse(line) as typeof reply;
  } catch {
    // Output from an extension is not a verifier response.
  }
  if (result.code !== 0 || reply?.managedVerification !== true)
    throw new ExtensionFailure('MANAGED_EXTENSION_INVALID', [
      redactPaths(
        typeof reply?.reason === 'string' ? reply.reason : 'the managed extension verifier could not complete',
        [
          [candidate.paths.directory, '<generation>'],
          [context.layout.root, '<extensions>'],
          [context.bundle.root, '<runtime>'],
        ]
      ).slice(0, 500),
    ]);
}

/**
 * The load check (ADR 5.5): start native the way a conversation does (see
 * `conversationArguments`, `--no-extensions`, one `-e` per source) and ask what loaded.
 *
 * Passing each extension as `-e <reference>` imports it and runs its `setup()` on the spot,
 * which is what catches a pack whose import or `setup()` fails; `status --json` and the
 * entry-point path both let such packs through. Passing the links directory instead binds
 * each pack's manifest, which is what conversations do with a pack (decision B5); there a
 * pack activated on a command is listed without being imported, so both checks are needed.
 * This runs code of the extension the user chose to install; what that code connects to is
 * outside the helper's control (ADR 5.9).
 */
export async function runLoadCheck(
  context: FlowContext,
  candidate: Candidate,
  sources: string[],
  expected: LoadExpectation
): Promise<LoadCheck> {
  const native = ['--offline', '--mode', 'rpc', '--no-session', '--no-extensions'];
  for (const source of sources) native.push('-e', source);
  let reply: ResourceReply | undefined;
  const result = await runToExit(
    context.spawn,
    {
      command: context.bundle.python,
      args: conversationArguments(context, candidate, native),
      env: loadEnvironment(context.base, candidate.paths.agent),
      cwd: candidate.paths.directory,
    },
    {
      timeoutMs: context.timeouts.verifyMs,
      signal: context.signal,
      input: JSON.stringify({ id: REQUEST_ID, type: 'aelix_control', method: 'resources/list', params: {} }) + '\n',
      closeInput: (line) => {
        try {
          const message = JSON.parse(line) as ResourceReply;
          if (message.id !== REQUEST_ID) return false;
          reply = message;
          return true;
        } catch {
          return false;
        }
      },
    }
  );
  return {
    problems: checkLoaded(expected, reply),
    answered: reply !== undefined,
    cancelled: result.cancelled,
    timedOut: result.timedOut,
  };
}

/**
 * Hide the locations of this machine in text native wrote (a load error names the files it
 * failed on): each given directory becomes its label, longest first, so a reason can be shown
 * or reported without the user's paths in it.
 */
export function redactPaths(text: string, locations: [directory: string, label: string][]): string {
  let redacted = redactUrlCredentials(text);
  for (const [directory, label] of locations
    .filter(([directory]) => directory.length > 1)
    .toSorted(([left], [right]) => right.length - left.length))
    redacted = redacted.replaceAll(directory, label);
  return redacted;
}
