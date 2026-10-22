import { spawnSync } from 'node:child_process';
const target = { darwin: '--mac', linux: '--linux' }[process.platform];
if (!target) throw new Error('Studio runtime currently requires macOS or Linux.');
for (const [command, args] of [
  ['python3', ['scripts/aelix-studio/prepareRuntime.py']],
  [process.execPath, ['scripts/build-with-builder.js', process.arch, target, `--${process.arch}`]],
]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
