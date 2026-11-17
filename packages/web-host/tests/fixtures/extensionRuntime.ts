/**
 * A stand-in for the bundled runtime in unit tests of the Studio extension helper.
 *
 * It answers the processes the helper starts (lock holder, lease probe, `venv`, the native
 * CLI in a generation, the load check) by doing on disk what the real ones do, so the
 * helper's own logic runs unchanged and no Python is needed. The integration test runs the
 * same flows against a real bundle.
 */
import { copyFile, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalName, parseExtensionEntries, parseRecordPaths } from '../../src/studio-extensions/inspect/metadata';
import type { Child, ChildExit, Spawn, SpawnSpec } from '../../src/studio-extensions/process';

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
  /** Replaces `extension install`: return the native exit code. */
  install?: (venv: Venv, wheel: string, spec: SpawnSpec) => Promise<number>;
  /** Replaces `extension remove`: return the native exit code. */
  remove?: (venv: Venv, entry: string) => Promise<number>;
  /** Entry names `extension verify` reports as not bound. */
  unbound?: string[];
  /** Load errors by object reference. */
  loadErrors?: Record<string, string>;
  /** Called when the load check starts, before it answers. Return false to keep native silent. */
  beforeLoad?: (child: ScriptedChild) => boolean | void | Promise<boolean | void>;
  /** Text every native run prints. */
  nativeOutput?: string;
};

/**
 * A spawn function that behaves like the bundled runtime for the helper's five kinds of
 * process. `options` is read at call time, so a test can change behaviour between steps.
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
    const inline = args.includes('-c') ? args[args.indexOf('-c') + 1] : '';
    if (inline.includes('try_lock')) {
      const mode = args[args.indexOf('-c') + 2];
      if (mode === 'hold') {
        child.onEnd = () => child.exit(0);
        if (options.lock) options.lock(child);
        else child.print('held\n');
        return;
      }
      finish(child, async () => {
        const names = await readdir(args[args.indexOf('-c') + 3]).catch(() => [] as string[]);
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
        if (platform === 'win32') await copyFile(bundlePython, python);
        else await symlink(bundlePython, python);
        await writeFile(
          path.join(root, 'pyvenv.cfg'),
          `home = ${path.dirname(bundlePython)}\ninclude-system-site-packages = false\nversion = 3.12.15\n`
        );
        return 0;
      });
      return;
    }
    if (inline.includes('runpy')) {
      child.onEnd = () => child.exit(0);
      child.onInput = (text) => {
        void (async () => {
          if ((await options.beforeLoad?.(child)) === false) return;
          const references = args.flatMap((arg, index) => (arg === '-e' ? [args[index + 1]] : []));
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
    const native = args.slice(args.indexOf('native') + 1).filter((arg) => arg !== '--offline');
    const venv = venvOf(spec.command, platform);
    finish(child, async () => {
      if (options.nativeOutput) child.print(options.nativeOutput);
      if (native[1] === 'install')
        return options.install ? options.install(venv, native[2], spec) : (await installWheel(venv, native[2]), 0);
      if (native[1] === 'remove') {
        if (options.remove) return options.remove(venv, native[2]);
        const info = await distributionInfo(venv, (_entry, entries) => entries.has(native[2]));
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
