/**
 * A stand-in for the bundled runtime in unit tests of the Studio extension helper.
 *
 * It answers the processes the helper starts (lock holder, lease probe, `venv`, the native
 * CLI in a generation, the load check) by doing on disk what the real ones do, so the
 * helper's own logic runs unchanged and no Python is needed. The integration test runs the
 * same flows against a real bundle.
 */
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { FlowContext } from '../../src/studio-extensions/flow/candidate';
import { baseEnvironment } from '../../src/studio-extensions/flow/environment';
import {
  canonicalName,
  nativeName,
  parseExtensionEntries,
  parseRecordPaths,
} from '../../src/studio-extensions/inspect/metadata';
import {
  spawnChild,
  type Child,
  type ChildExit,
  type Spawn,
  type SpawnSpec,
} from '../../src/studio-extensions/process';
import { ensureLayout, locateLayout, resolveBundle } from '../../src/studio-extensions/store/layout';
import type { StateWriter } from '../../src/studio-extensions/store/lock';
import { ExtensionFailure } from '../../src/studio-extensions/types';

/** `[plugin] id` and `[plugin.entry] python` of a fixture manifest, read with patterns. */
export function manifestFields(text: string): { id: string | null; python: string | null } {
  const plugin = /^\[plugin\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const entry = /^\[plugin\.entry\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return {
    id: /^id\s*=\s*"([^"]*)"/m.exec(plugin)?.[1] ?? null,
    python: /^python\s*=\s*"([^"]*)"/m.exec(entry)?.[1] ?? null,
  };
}

/** A child whose behaviour a test scripts. */
export class ScriptedChild implements Child {
  readonly written: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  ended = false;
  private stdout: ((chunk: string) => void)[] = [];
  private stderr: ((chunk: string) => void)[] = [];
  private resolveExit!: (exit: ChildExit) => void;
  private finished = false;
  private inputListener?: (text: string) => void;
  private endListener?: () => void;
  readonly exited = new Promise<ChildExit>((resolve) => {
    this.resolveExit = resolve;
  });
  /** Called for each signal; the default ends the child. */
  onKill?: (signal: NodeJS.Signals) => void;

  /** Called for each write to the child's input, including what was written before this was set. */
  set onInput(listener: (text: string) => void) {
    this.inputListener = listener;
    for (const text of this.written) listener(text);
  }
  /** Called when the input is closed, also when it was closed before this was set. */
  set onEnd(listener: () => void) {
    this.endListener = listener;
    if (this.ended) listener();
  }

  onStdout(listener: (chunk: string) => void): void {
    this.stdout.push(listener);
  }
  onStderr(listener: (chunk: string) => void): void {
    this.stderr.push(listener);
  }
  write(text: string): void {
    this.written.push(text);
    this.inputListener?.(text);
  }
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.endListener?.();
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.onKill) this.onKill(signal);
    else this.exit(null, signal);
  }
  print(text: string): void {
    for (const listener of this.stdout) listener(text);
  }
  complain(text: string): void {
    for (const listener of this.stderr) listener(text);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null, failedToStart = false): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveExit({ code, signal, failedToStart });
  }
}

/** A spawn function that hands every call to `script` and records it. */
export function scriptedSpawn(script: (spec: SpawnSpec, child: ScriptedChild) => void): Spawn & {
  calls: SpawnSpec[];
  children: ScriptedChild[];
} {
  const calls: SpawnSpec[] = [];
  const children: ScriptedChild[] = [];
  const spawn = (spec: SpawnSpec): Child => {
    const child = new ScriptedChild();
    calls.push(spec);
    children.push(child);
    // Like a real process, the child acts after the caller attached its listeners.
    queueMicrotask(() => script(spec, child));
    return child;
  };
  return Object.assign(spawn, { calls, children });
}

/**
 * What the lock holder does to shared state, done here with Node: rename a temporary file
 * over a pointer file or the settings file, and remove one entry of the root or of a dedicated directory, but
 * only when that directory is a real directory where its path says it is.
 */
export function directWriter(root: string): StateWriter {
  const refused = (): ExtensionFailure => new ExtensionFailure('UNSAFE_ROOT', ['refused by the lock holder']);
  const plain = (name: string): boolean =>
    !['', '.', '..'].includes(name) && !['/', '\\', '\u0000'].some((mark) => name.includes(mark));
  const own = async (directory: string): Promise<boolean> => {
    const stats = await lstat(directory).catch(() => undefined);
    return !stats || (stats.isDirectory() && (await realpath(directory)) === directory);
  };
  return {
    replace: async (from, to) => {
      const replaceable =
        ['current.json', 'current.previous.json', 'settings.json'].includes(to) ||
        /^proxy-credentials-[0-9a-f]{32}\.json$/.test(to);
      if (!replaceable || !plain(from) || !from.endsWith('.tmp') || !(await own(root))) throw refused();
      await rename(path.join(root, from), path.join(root, to));
    },
    remove: async (relative) => {
      const parts = relative.split('/');
      const dedicated = ['generations', 'artifacts', 'leases'].includes(parts[0]);
      if (!parts.every(plain) || !(parts.length === 1 || (parts.length === 2 && dedicated))) throw refused();
      const parent = path.join(root, ...parts.slice(0, -1));
      if (!(await own(parent))) throw refused();
      const target = path.join(parent, parts.at(-1) ?? '');
      const stats = await lstat(target).catch(() => undefined);
      if (stats?.isDirectory()) await rm(target, { recursive: true, force: true });
      else if (stats) await unlink(target);
    },
  };
}

export type FakeBundleOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Distributions in `native-site`: name to version. Each gets a top-level package of its import name. */
  distributions?: Record<string, string>;
  lock?: string;
};

/** Write a directory that `resolveBundle` accepts and return its path. */
export async function createFakeBundle(directory: string, options: FakeBundleOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const python = path.join(directory, 'python', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
  await mkdir(path.dirname(python), { recursive: true });
  await writeFile(python, 'bundled interpreter');
  await writeFile(path.join(directory, 'launch.py'), '# launcher');
  const site = path.join(directory, 'native-site');
  await mkdir(site, { recursive: true });
  for (const [name, version] of Object.entries(options.distributions ?? { packaging: '26.3' })) {
    const module = name.replace(/[-.]/g, '_');
    const info = path.join(site, `${module}-${version}.dist-info`);
    await mkdir(info, { recursive: true });
    await mkdir(path.join(site, module), { recursive: true });
    await writeFile(path.join(info, 'METADATA'), `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`);
    await writeFile(path.join(info, 'RECORD'), `${module}/__init__.py,,\n`);
  }
  await writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      schema: 'aelix.studio-preview.runtime/1',
      target: `${platform}-${options.arch ?? process.arch}`,
      python: '3.12.15',
      dependencyLockSha256: options.lock ?? 'a'.repeat(64),
      native: { sourceTag: { commit: 'c'.repeat(40) } },
    })
  );
  return directory;
}

/** Members of a zip whose members are stored, as the fixture wheels are. */
export function unzipStored(archive: Buffer): [name: string, content: Buffer][] {
  const members: [string, Buffer][] = [];
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let cursor = archive.readUInt32LE(end + 16);
  for (let index = 0; index < archive.readUInt16LE(end + 10); index += 1) {
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    members.push([name, archive.subarray(start, start + size)]);
    cursor += 46 + nameLength + archive.readUInt16LE(cursor + 30) + archive.readUInt16LE(cursor + 32);
  }
  return members;
}

type Venv = { root: string; site: string; scripts: string; python: string };

function venvOf(python: string, platform: NodeJS.Platform): Venv {
  const scripts = path.dirname(python);
  const root = path.dirname(scripts);
  const site =
    platform === 'win32'
      ? path.join(root, 'Lib', 'site-packages')
      : path.join(root, 'lib', 'python3.12', 'site-packages');
  return { root, site, scripts, python };
}

async function removeDistribution(venv: Venv, info: string): Promise<void> {
  const record = await readFile(path.join(venv.site, info, 'RECORD'), 'utf8');
  for (const listed of parseRecordPaths(record)) await rm(path.resolve(venv.site, listed), { force: true });
  await rm(path.join(venv.site, info), { recursive: true, force: true });
}

async function distributionInfo(venv: Venv, matches: (info: string, entries: Map<string, string>) => boolean) {
  for (const entry of await readdir(venv.site)) {
    if (!entry.endsWith('.dist-info')) continue;
    const points = await readFile(path.join(venv.site, entry, 'entry_points.txt'), 'utf8').catch(() => '');
    if (matches(entry, parseExtensionEntries(points))) return entry;
  }
  return undefined;
}

/** Install a fixture wheel the way pip does, enough for the helper to read the result. */
export async function installWheel(venv: Venv, wheel: string): Promise<void> {
  const members = unzipStored(await readFile(wheel));
  const info = members.find(([name]) => name.endsWith('.dist-info/METADATA'))?.[0].split('/')[0] ?? '';
  const distribution = canonicalName(info.split('-')[0]);
  const previous = await distributionInfo(venv, (entry) => canonicalName(entry.split('-')[0]) === distribution);
  if (previous) await removeDistribution(venv, previous);
  const record: string[] = [];
  const place = async (file: string, content: Buffer | string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    // pip unlinks what is there before it writes, so it replaces a link instead of following it.
    await rm(file, { force: true });
    await writeFile(file, content);
    // RECORD paths are relative to site-packages and use `/`, also for files outside it.
    record.push(`${path.relative(venv.site, file).split(path.sep).join('/')},,`);
  };
  for (const [name, content] of members) {
    const parts = name.split('/');
    if (name.endsWith('.dist-info/RECORD')) continue;
    if (!parts[0].endsWith('.data')) await place(path.join(venv.site, ...parts), content);
    else if (parts[1] === 'purelib' || parts[1] === 'platlib')
      await place(path.join(venv.site, ...parts.slice(2)), content);
    else if (parts[1] === 'data') await place(path.join(venv.root, ...parts.slice(2)), content);
    else if (parts[1] === 'scripts') await place(path.join(venv.scripts, ...parts.slice(2)), content);
  }
  const points = members.find(([name]) => name === `${info}/entry_points.txt`)?.[1].toString() ?? '';
  const scripts = /\[console_scripts\]\n((?:[^[\n].*\n)*)/.exec(points)?.[1] ?? '';
  for (const line of scripts.split('\n').filter(Boolean)) {
    const name = line.split('=')[0].trim();
    await place(path.join(venv.scripts, name), `#!${venv.python}\nprint("${name}")\n`);
  }
  await writeFile(path.join(venv.site, info, 'RECORD'), [...record, `${info}/RECORD,,`].join('\n') + '\n');
}

export type FakeRuntimeOptions = {
  bundle: string;
  platform?: NodeJS.Platform;
  /** Lease files the probe reports as held by a running launcher. */
  heldLeases?: string[];
  /** What the lock holder prints: `held` unless a test says otherwise. */
  lock?: (child: ScriptedChild) => void;
  /** A request the lock holder fails, as an interruption would: true answers an `OSError`. */
  holderFails?: (request: { op: string; from?: string; to?: string; path?: string }) => boolean;
  /** Replaces `extension install`: return the native exit code. `print` writes to its stdout. */
  install?: (venv: Venv, wheel: string, spec: SpawnSpec, print: (text: string) => void) => Promise<number>;
  /** Replaces `extension remove`: return the native exit code. */
  remove?: (venv: Venv, entry: string) => Promise<number>;
  /** Replaces `pip check` when revalidating a generation against a new bundle. */
  checkDependencies?: () => number;
  /** Answers pip's upgrade probe or candidate uninstall. */
  pip?: (spec: SpawnSpec, child: ScriptedChild) => Promise<number>;
  /** Entry names `extension verify` reports as not bound. */
  unbound?: string[];
  /** Load errors by object reference. */
  loadErrors?: Record<string, string>;
  /** Optional refusal from ACP's managed catalogue verifier. */
  managedError?: string;
  /** Called when the load check starts, before it answers. Return false to keep native silent. */
  beforeLoad?: (child: ScriptedChild) => boolean | void | Promise<boolean | void>;
  /** Text every native run prints. */
  nativeOutput?: string;
  /** Answers `git` runs (Studio's own fetch and credential lookup). Without it the real `git` runs. */
  git?: (spec: SpawnSpec, child: ScriptedChild) => void;
};

/**
 * A spawn function that behaves like the bundled runtime for the helper's five kinds of
 * process, and runs (or lets a test answer) the `git` Studio starts itself. `options` is read at call time, so a test can change behaviour between steps.
 */
export function fakeRuntime(options: FakeRuntimeOptions): ReturnType<typeof scriptedSpawn> {
  const platform = options.platform ?? process.platform;
  const bundlePython = path.join(
    options.bundle,
    'python',
    ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])
  );
  const finish = (child: ScriptedChild, work: () => Promise<number>): void => {
    work().then(
      (code) => child.exit(code),
      (error: unknown) => {
        child.complain(String(error));
        child.exit(70);
      }
    );
  };
  return scriptedSpawn((spec, child) => {
    const { args } = spec;
    /** Hand the call to a real process and pass everything back. */
    const bridge = (real: Child): void => {
      real.onStdout((chunk) => child.print(chunk));
      real.onStderr((chunk) => child.complain(chunk));
      child.onEnd = () => real.end();
      child.onKill = (signal) => real.kill(signal);
      void real.exited.then((exit) => child.exit(exit.code, exit.signal, exit.failedToStart));
    };
    if (spec.command === 'git') {
      if (options.git) return options.git(spec, child);
      return bridge(spawnChild(spec));
    }
    const inline = args.includes('-c') ? args[args.indexOf('-c') + 1] : '';
    // Studio's no-follow tree copy is plain Python; the system's runs it as the bundle's would.
    if (inline.includes('aelix-studio-copy-tree')) return bridge(spawnChild({ ...spec, command: 'python3' }));
    if (inline.includes('try_lock')) {
      const mode = args[args.indexOf('-c') + 2];
      if (mode === 'hold') {
        // The holder carries out the requests it is sent, one after the other, and answers each.
        const writer = directWriter(path.dirname(args[args.indexOf('-c') + 3]));
        let last: Promise<void> = Promise.resolve();
        child.onEnd = () => child.exit(0);
        child.onInput = (text) => {
          for (const line of text.split('\n').filter(Boolean)) {
            const request = JSON.parse(line) as { op: string; from: string; to: string; path: string };
            last = last
              .then(() => {
                if (options.holderFails?.(request)) throw new Error('interrupted');
                return request.op === 'replace'
                  ? writer.replace(request.from, request.to)
                  : writer.remove(request.path);
              })
              .then(
                () => child.print('{"ok": true}\n'),
                (error: unknown) =>
                  child.print(
                    error instanceof ExtensionFailure
                      ? '{"ok": false, "refused": true}\n'
                      : '{"ok": false, "error": "OSError"}\n'
                  )
              );
          }
        };
        if (options.lock) options.lock(child);
        else child.print('held\n');
        return;
      }
      finish(child, async () => {
        const names = (await readdir(args[args.indexOf('-c') + 3]).catch(() => [] as string[])).filter(
          (name) => !name.endsWith('.snapshot.json')
        );
        const live = names.filter((name) => options.heldLeases?.includes(name));
        child.print(JSON.stringify({ live, stale: names.filter((name) => !live.includes(name)) }) + '\n');
        return 0;
      });
      return;
    }
    if (args.includes('venv')) {
      finish(child, async () => {
        const root = args[args.indexOf('venv') + 1];
        const venv = venvOf(path.join(root, platform === 'win32' ? 'Scripts' : 'bin', 'python'), platform);
        const python = platform === 'win32' ? path.join(venv.scripts, 'python.exe') : venv.python;
        await mkdir(venv.scripts, { recursive: true });
        await mkdir(path.join(venv.site, 'pip'), { recursive: true });
        await mkdir(path.join(venv.site, 'pip-26.0.dist-info'), { recursive: true });
        await writeFile(path.join(venv.site, 'pip', '__init__.py'), '');
        await writeFile(path.join(venv.site, 'pip-26.0.dist-info', 'METADATA'), 'Name: pip\nVersion: 26.0\n');
        await writeFile(path.join(venv.site, 'pip-26.0.dist-info', 'RECORD'), 'pip/__init__.py,,\n');
        // The entries `python -m venv` creates next to the interpreter.
        if (platform === 'win32') {
          await copyFile(bundlePython, python);
          await copyFile(bundlePython, path.join(venv.scripts, 'pythonw.exe'));
        } else {
          await symlink(bundlePython, path.join(venv.scripts, 'python3'));
          await symlink('python3', python);
          await symlink('python3', path.join(venv.scripts, 'python3.12'));
        }
        await writeFile(path.join(venv.scripts, platform === 'win32' ? 'pip.exe' : 'pip'), 'pip launcher');
        await writeFile(
          path.join(root, 'pyvenv.cfg'),
          `home = ${path.dirname(bundlePython)}\ninclude-system-site-packages = false\nversion = 3.12.15\n`
        );
        return 0;
      });
      return;
    }
    if (inline.includes('tomllib')) {
      // The manifest reader: `[plugin] id` and `[plugin.entry] python` of each manifest it is given.
      finish(child, async () => {
        const site = args[args.indexOf('-c') + 2];
        const wanted = JSON.parse(args[args.indexOf('-c') + 3]) as Record<string, string>;
        const answers: Record<string, { id: string | null; python: string | null }> = Object.create(null);
        for (const [name, relative] of Object.entries(wanted)) {
          const text = await readFile(path.join(site, ...relative.split('/')), 'utf8').catch(() => '');
          answers[name] = manifestFields(text);
        }
        child.print(JSON.stringify(answers) + '\n');
        return 0;
      });
      return;
    }
    if (args.includes('verify-managed')) {
      child.onEnd = () => {
        const reason = options.managedError;
        child.print(JSON.stringify({ managedVerification: !reason, reason }) + '\n');
        child.exit(reason ? 1 : 0);
      };
      return;
    }
    if (args.includes('native-generation')) {
      child.onEnd = () => child.exit(0);
      child.onInput = (text) => {
        void (async () => {
          if ((await options.beforeLoad?.(child)) === false) return;
          // A directory is a links directory: each pack in it is reported by its plugin id.
          const references: string[] = [];
          for (const source of args.flatMap((arg, index) => (arg === '-e' ? [args[index + 1]] : []))) {
            if (!path.isAbsolute(source)) {
              references.push(source);
              continue;
            }
            for (const link of (await readdir(source)).toSorted()) {
              const text = await readFile(path.join(source, link, 'aelix-plugin.toml'), 'utf8').catch(() => '');
              references.push(manifestFields(text).id ?? link);
            }
          }
          const failed = references.filter((reference) => options.loadErrors?.[reference] !== undefined);
          child.print('not json\n');
          child.print(
            JSON.stringify({
              id: (JSON.parse(text) as { id: string }).id,
              type: 'response',
              command: 'aelix_control',
              success: true,
              data: {
                extensions: [
                  { name: 'GuardrailExtension', source: null },
                  ...references.filter((reference) => !failed.includes(reference)).map((name) => ({ name })),
                ],
                extensionErrors: failed.map((source) => ({ source, message: options.loadErrors?.[source] })),
              },
            }) + '\n'
          );
        })();
      };
      return;
    }
    if (args.slice(-3).join(' ') === '-m pip check') {
      child.exit(options.checkDependencies?.() ?? 0);
      return;
    }
    if (inline.includes('aelix-studio-bounded-index-pip') && !args.includes('--dry-run')) {
      finish(child, async () =>
        options.install
          ? options.install(venvOf(spec.command, platform), args.at(-1) ?? '', spec, (text) => child.print(text))
          : 2
      );
      return;
    }
    if ((args.includes('-m') && args.includes('pip')) || inline.includes('aelix-studio-bounded-index-pip')) {
      finish(child, async () => (options.pip ? options.pip(spec, child) : 2));
      return;
    }
    const native = args.slice(args.indexOf('native') + 1).filter((arg) => arg !== '--offline');
    const venv = venvOf(spec.command, platform);
    finish(child, async () => {
      if (options.nativeOutput) child.print(options.nativeOutput);
      if (native[1] === 'install')
        return options.install
          ? options.install(venv, native[2], spec, (text) => child.print(text))
          : (await installWheel(venv, native[2]), 0);
      if (native[1] === 'remove') {
        if (options.remove) return options.remove(venv, native[2]);
        // native compares names loosely (case, `_` as `-`) and takes the first entry that matches.
        const wanted = nativeName(native[2]);
        const info =
          (await distributionInfo(venv, (_entry, entries) =>
            [...entries.keys()].some((entry) => nativeName(entry) === wanted)
          )) ??
          (await distributionInfo(
            venv,
            (entry, entries) => entries.size > 0 && nativeName(entry.split('-')[0]) === wanted
          ));
        if (!info) return 2;
        await removeDistribution(venv, info);
        return 0;
      }
      if (native[1] === 'verify') {
        const unbound = options.unbound ?? [];
        return (native[2] === undefined ? unbound.length > 0 : unbound.includes(native[2])) ? 1 : 0;
      }
      return 2;
    });
  });
}

export type FakeHelper = {
  context: FlowContext;
  spawn: ReturnType<typeof scriptedSpawn>;
  /** Behaviour of the fake runtime; change it between steps. */
  runtime: FakeRuntimeOptions;
  /** Native argument lists of the management runs, without the launcher prefix. */
  nativeRuns(): string[][];
};

/**
 * A flow context on a fake bundle under `scratch`, for the platform the tests run on. The
 * state root has a space in its path, like "Application Support".
 */
export async function createFakeHelper(scratch: string, options: FakeBundleOptions = {}): Promise<FakeHelper> {
  const platform = process.platform;
  const bundle = await resolveBundle(await createFakeBundle(path.join(scratch, 'bundle'), options));
  if (!bundle) throw new Error('the fake bundle did not resolve');
  const runtime: FakeRuntimeOptions = { bundle: bundle.root };
  const spawn = fakeRuntime(runtime);
  const layout = await locateLayout(path.join(scratch, 'Application Support', 'aelix-runtime'));
  await ensureLayout(layout);
  return {
    context: {
      bundle,
      layout,
      platform,
      spawn,
      base: baseEnvironment({ PATH: '/usr/bin', HOME: path.join(scratch, 'home'), PIP_TARGET: '/elsewhere' }, platform),
      timeouts: { lockMs: 1000, environmentMs: 5000, installerMs: 5000, verifyMs: 5000 },
    },
    spawn,
    runtime,
    nativeRuns: () =>
      spawn.calls
        .filter((call) => call.command !== bundle.python && call.args.includes('native'))
        .map((call) => call.args.slice(call.args.indexOf('native') + 1)),
  };
}
