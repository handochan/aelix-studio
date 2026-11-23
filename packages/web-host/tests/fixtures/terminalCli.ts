/**
 * A terminal CLI's files, as uv, pipx and pip leave them, for tests that read them. Every
 * launcher written here would leave a marker file if anything ran it; `ranAnything` says so.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const write = async (file: string, text = ''): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
};

/** A distribution in `site`, with an optional `entry_points.txt`. */
export const distribution = async (
  site: string,
  name: string,
  version: string,
  entryPoints?: string
): Promise<void> => {
  // Installers write the name with `_` for `-` and `.` (wheel file name escaping).
  const info = path.join(site, `${name.replace(/[-.]+/g, '_')}-${version}.dist-info`);
  await write(
    path.join(info, 'METADATA'),
    `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n\nA long description.\n`
  );
  await write(path.join(info, 'RECORD'), '');
  if (entryPoints) await write(path.join(info, 'entry_points.txt'), entryPoints);
};

/** The marker a launcher leaves when run: nothing may ever run one. */
export const markerOf = (scratch: string): string => path.join(scratch, 'RAN');

/** A launcher script that names `interpreter` and leaves the marker if it runs. */
export const launcherScript = (interpreter: string, scratch: string): string =>
  `#!${interpreter}\n# -*- coding: utf-8 -*-\nimport pathlib\npathlib.Path(${JSON.stringify(markerOf(scratch))}).touch()\n`;

/**
 * A virtual environment at `root` holding the CLI (`aelix`) and `packs` (distribution name to
 * entry name), with its `bin/aelix` launcher. POSIX layout unless `windows`.
 */
export async function cliVenv(
  root: string,
  scratch: string,
  packs: Record<string, string> = {},
  options: { windows?: boolean; cli?: boolean } = {}
): Promise<void> {
  await write(path.join(root, 'pyvenv.cfg'), 'home = /opt/python/bin\ninclude-system-site-packages = false\n');
  const site = options.windows
    ? path.join(root, 'Lib', 'site-packages')
    : path.join(root, 'lib', 'python3.12', 'site-packages');
  if (options.cli ?? true)
    await distribution(site, 'aelix', '0.1.0b2', '[console_scripts]\naelix = aelix_coding_agent.cli.entry:main_sync\n');
  else await distribution(site, 'ruff', '0.9.0', '[console_scripts]\nruff = ruff.__main__:main\n');
  for (const [name, entry] of Object.entries(packs))
    await distribution(site, name, '1.0.0', `[aelix.extensions]\n${entry} = ${name.replaceAll('-', '_')}:setup\n`);
  if (!options.windows) {
    const launcher = path.join(root, 'bin', 'aelix');
    await write(launcher, launcherScript(path.join(root, 'bin', 'python'), scratch));
    await chmod(launcher, 0o755);
  }
}

/** A link at `at` to `target`, making its directory. */
export async function link(target: string, at: string): Promise<void> {
  await mkdir(path.dirname(at), { recursive: true });
  await symlink(target, at);
}

export const ranAnything = (scratch: string): boolean => existsSync(markerOf(scratch));
