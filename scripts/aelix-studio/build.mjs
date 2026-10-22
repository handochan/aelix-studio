import { spawnSync } from 'node:child_process';
const target = { darwin: '--mac', linux: '--linux', win32: '--win' }[process.platform];
if (!target) throw new Error(`Unsupported Studio build host: ${process.platform}`);
const runtimeOnly = process.argv[2] === '--runtime-only';
if (process.argv.length > (runtimeOnly ? 3 : 2)) throw new Error('Usage: build.mjs [--runtime-only]');
for (const [command, args] of [
  [process.platform === 'win32' ? 'python' : 'python3', ['scripts/aelix-studio/prepareRuntime.py']],
  ...(runtimeOnly
    ? []
    : [[process.execPath, ['scripts/build-with-builder.js', process.arch, target, `--${process.arch}`]]]),
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
