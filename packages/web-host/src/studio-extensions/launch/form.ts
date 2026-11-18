import { lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import type { Candidate, FlowContext } from '../flow/candidate.js';
import type { SiteSnapshot } from '../inspect/site.js';
import { runToExit } from '../process.js';
import { ExtensionFailure } from '../types.js';

/**
 * How conversations are given the extensions of a generation (D04 ADR 8.3, decision B5).
 * The launcher (`launch.py`) passes `--extension <generation>/packs` when `packs` is set, then
 * every module reference in order; the conversation load check passes exactly the same.
 */
export type LaunchForm = {
  /** Whether the generation's `packs` directory is passed: one link per pack, which binds its manifest. */
  packs: boolean;
  /** Module references passed one by one after the packs: their code loads, their manifest does not. */
  modules: string[];
};

/** How one extension is passed to a conversation. */
export type ExtensionForm = { form: 'pack'; plugin: string; directory: string } | { form: 'module' };

/** The directory of pack links inside a generation. */
export const PACKS_DIRECTORY = 'packs';

const MANIFEST = 'aelix-plugin.toml';

/**
 * The module reference a conversation is given for an entry point. A bare module becomes
 * `module:setup`: native's `-e` loader reads a bare module as that module's `setup`
 * (`_factory_from_module` at the native pin), so the meaning is the same, and the adapter
 * then never takes it for a path. Given as `demo`, it refuses to start any session whose
 * working directory holds something called `demo` ("A project path shadows this module
 * reference"); nothing is called `demo:setup`.
 */
export function conversationReference(reference: string): string {
  return reference.includes(':') ? reference : `${reference}:setup`;
}

/** The `--extension` values of a launch form, in the order they are passed. */
export function launchArguments(generationDirectory: string, form: LaunchForm): string[] {
  return [...(form.packs ? [path.join(generationDirectory, PACKS_DIRECTORY)] : []), ...form.modules];
}

/** The launch form of a set of extensions: packs as links, everything else by reference in name order. */
export function launchFormOf(expected: Map<string, string>, forms: Map<string, ExtensionForm>): LaunchForm {
  const names = [...expected.keys()].toSorted();
  return {
    packs: names.some((name) => forms.get(name)?.form === 'pack'),
    modules: names
      .filter((name) => forms.get(name)?.form !== 'pack')
      .map((name) => conversationReference(expected.get(name) ?? '')),
  };
}

/** What a conversation reports as loaded for each extension: the plugin id of a pack, the reference otherwise. */
export function loadedNames(expected: Map<string, string>, forms: Map<string, ExtensionForm>): Map<string, string> {
  return new Map(
    [...expected].map(([name, reference]) => {
      const form = forms.get(name);
      return [name, form?.form === 'pack' ? form.plugin : conversationReference(reference)];
    })
  );
}

/**
 * Reads `[plugin] id` and `[plugin.entry] python` of the manifests it is given, with the
 * bundle's own TOML reader. It only reads files; no extension code is imported.
 */
const MANIFEST_READER = `
import json, os, sys, tomllib
site, wanted = sys.argv[1], json.loads(sys.argv[2])
answers = {}
for name, relative in wanted.items():
    try:
        with open(os.path.join(site, *relative.split('/')), 'rb') as handle:
            data = tomllib.load(handle)
        plugin = data.get('plugin')
        plugin = plugin if isinstance(plugin, dict) else {}
        entry = plugin.get('entry')
        entry = entry if isinstance(entry, dict) else {}
        answers[name] = {'id': plugin.get('id'), 'python': entry.get('python')}
    except Exception:
        answers[name] = {'id': None, 'python': None}
print(json.dumps(answers))
`;

type ManifestFields = { id: unknown; python: unknown };

/**
 * The manifest native binds to an entry point when it walks the entry module's path: the
 * deepest `<package>/aelix-plugin.toml` the distribution records. Undefined when there is none.
 */
export function manifestOf(reference: string, recorded: string[]): string | undefined {
  const files = new Set(recorded.map((file) => file.replaceAll('\\', '/')));
  const parts = reference.split(':')[0].split('.');
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = [...parts.slice(0, length), MANIFEST].join('/');
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Decide how each expected extension is passed to a conversation (decision B5). It is a pack,
 * passed through the links directory so its manifest binds, when all of these hold:
 * - native's `extension verify` says its manifest binds for the entry point;
 * - the manifest sits in a package on the entry module's own path, inside the generation;
 * - that manifest's `[plugin.entry] python` is exactly the entry point's reference;
 * - its plugin id is not that of another pack.
 * Every other extension is passed by module reference: its code loads, what its manifest
 * declares does not. Whether a pack really loads in that form is the load check's to say.
 *
 * @throws ExtensionFailure `VERIFICATION_FAILED` when the manifests cannot be read at all.
 */
export async function chooseForms(
  context: FlowContext,
  candidate: Candidate,
  snapshot: SiteSnapshot,
  expected: Map<string, string>,
  bound: Map<string, boolean>
): Promise<Map<string, ExtensionForm>> {
  const forms = new Map<string, ExtensionForm>([...expected.keys()].map((name) => [name, { form: 'module' }]));
  const site = await realpath(candidate.paths.site);
  const wanted: Record<string, string> = {};
  for (const [name, reference] of expected) {
    const extension = snapshot.extensions.get(name);
    const distribution = extension && snapshot.distributions.get(extension.distribution);
    const manifest = distribution && bound.get(name) ? manifestOf(reference, distribution.files) : undefined;
    if (manifest === undefined) continue;
    const directory = path.join(site, ...path.posix.dirname(manifest).split('/'));
    // oxlint-disable-next-line no-await-in-loop -- a handful of directories, checked in order
    const stats = await lstat(directory).catch((): undefined => undefined);
    // oxlint-disable-next-line no-await-in-loop
    if (!stats?.isDirectory() || (await realpath(directory)) !== directory) continue;
    wanted[name] = manifest;
  }
  if (Object.keys(wanted).length === 0) return forms;
  const result = await runToExit(
    context.spawn,
    {
      command: context.bundle.python,
      args: ['-I', '-S', '-B', '-X', 'utf8', '-c', MANIFEST_READER, site, JSON.stringify(wanted)],
      env: context.base,
      cwd: candidate.paths.directory,
    },
    { timeoutMs: context.timeouts.verifyMs, signal: context.signal, tailLimit: 1024 * 1024 }
  );
  if (result.cancelled) throw new ExtensionFailure('CANCELLED');
  let answers: Record<string, ManifestFields>;
  try {
    if (result.code !== 0) throw new Error('the manifest reader failed');
    answers = JSON.parse(result.output.split('\n').findLast((line) => line.startsWith('{')) ?? '') as Record<
      string,
      ManifestFields
    >;
  } catch {
    throw new ExtensionFailure('VERIFICATION_FAILED', ['the manifests of the extensions could not be read']);
  }
  const fitting = Object.keys(wanted).filter((name) => {
    const fields = answers[name];
    // A bare module entry point names that module's `setup`, as a manifest entry always spells it.
    return (
      typeof fields?.id === 'string' &&
      fields.id !== '' &&
      fields.python === conversationReference(expected.get(name) ?? '')
    );
  });
  const plugins = fitting.map((name) => answers[name].id as string);
  for (const name of fitting) {
    const plugin = answers[name].id as string;
    if (plugins.indexOf(plugin) !== plugins.lastIndexOf(plugin)) continue;
    forms.set(name, { form: 'pack', plugin, directory: path.posix.dirname(wanted[name]) });
  }
  return forms;
}

/**
 * Create the links directory of a candidate: one relative link per pack, named so that native
 * loads them in entry-name order, pointing at the package that holds the pack's manifest.
 * Nothing is created when there is no pack.
 */
export async function writePacks(candidate: Candidate, forms: Map<string, ExtensionForm>): Promise<void> {
  const packs = [...forms]
    .filter((entry): entry is [string, Extract<ExtensionForm, { form: 'pack' }>] => entry[1].form === 'pack')
    .toSorted(([left], [right]) => (left < right ? -1 : 1));
  if (packs.length === 0) return;
  const directory = path.join(candidate.paths.directory, PACKS_DIRECTORY);
  await mkdir(directory);
  for (const [index, [name, pack]] of packs.entries()) {
    const target = path.join(candidate.paths.site, ...pack.directory.split('/'));
    // oxlint-disable-next-line no-await-in-loop -- a handful of links, made in order
    await symlink(path.relative(directory, target), path.join(directory, `${String(index).padStart(3, '0')}-${name}`));
  }
}
