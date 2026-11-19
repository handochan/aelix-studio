/**
 * A copy of a bundled runtime for the integration tests of the Studio extension helper.
 *
 * The copy gets this branch's `launch.py`, so the tests exercise the launcher they ship with.
 * Everything else in it must stay exactly as its `checksums.json` says.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAUNCHER = fileURLToPath(new URL('../../../../scripts/studio-preview/packaging/launch.py', import.meta.url));

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * Put this branch's launcher into a bundle copy. Returns what `bundleDifferences` must
 * expect in place of the copy's own checksums for the files it replaced.
 */
export async function useBranchLauncher(bundle: string): Promise<Record<string, string>> {
  const launcher = await readFile(LAUNCHER);
  const target = path.join(bundle, 'launch.py');
  if (sha256(await readFile(target)) !== sha256(launcher)) await writeFile(target, launcher);
  return { 'launch.py': sha256(launcher) };
}

/** Compare every file of a bundle copy with its own `checksums.json`; returns the paths that differ. */
export async function bundleDifferences(root: string, replaced: Record<string, string> = {}): Promise<string[]> {
  const expected = {
    ...(JSON.parse(await readFile(path.join(root, 'checksums.json'), 'utf8')) as Record<string, string>),
    ...replaced,
  };
  const actual: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const key = path.relative(root, file).split(path.sep).join('/');
      if (entry.isSymbolicLink()) actual[key] = `symlink:${await readlink(file)}`;
      else if (entry.isDirectory()) await walk(file);
      else if (key !== 'checksums.json') actual[key] = sha256(await readFile(file));
    }
  };
  await walk(root);
  delete expected['checksums.json'];
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
    (key) => expected[key] !== actual[key]
  );
}
