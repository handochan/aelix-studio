import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verifyConfigPreserved } from '../../scripts/studio-preview/host-release/verification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values } = parseArgs({
  options: {
    output: { type: 'string', default: '.local/config-persist' },
    runs: { type: 'string', default: '40' },
    baseline: { type: 'string', default: 'bf8193b20' },
    electron: { type: 'string' },
    'prepare-only': { type: 'boolean' },
    'execute-only': { type: 'boolean' },
    'no-sandbox': { type: 'boolean' },
  },
});
const output = path.resolve(root, values.output);
fs.mkdirSync(output, { recursive: true });
function command(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${binary} failed: ${result.stderr || result.error}`);
  return result.stdout;
}
function build(entry, name) {
  command('bun', [
    'build',
    entry,
    '--target=node',
    '--format=cjs',
    '--external=electron',
    `--outfile=${path.join(output, name)}`,
  ]);
}
if (!values['execute-only']) {
  build(path.join(root, 'tests/manual/configPersist.ts'), 'fixed.cjs');
  const baseline = path.join(output, 'baseline');
  fs.mkdirSync(baseline, { recursive: true });
  const source = (file) => command('git', ['show', `${values.baseline}:${file}`]);
  const storage = source('packages/desktop/src/process/utils/initStorage.ts');
  const implementation = storage.slice(storage.indexOf('const WriteFile ='), storage.indexOf('const envFile ='));
  assert.ok(implementation.includes('const JsonFileBuilder ='), 'Baseline must contain the original JSON store');
  fs.writeFileSync(
    path.join(baseline, 'jsonFile.ts'),
    `import fs from 'node:fs/promises';
import {readFileSync,existsSync,mkdirSync} from 'node:fs'; import path from 'node:path'; const nodePath=path;
${implementation}\nexport {JsonFileBuilder as createJsonFileStore};\n`
  );
  for (const [name, original] of [
    ['windowBounds', 'utils/windowBounds'],
    ['persistOnQuit', 'utils/persistOnQuit'],
    ['quitCleanup', 'startup/quitCleanup'],
  ])
    fs.writeFileSync(path.join(baseline, `${name}.ts`), source(`packages/desktop/src/process/${original}.ts`));
  let entry = fs.readFileSync(path.join(root, 'tests/manual/configPersist.ts'), 'utf8');
  for (const [original, replacement] of [
    ['storage/jsonFile', 'jsonFile'],
    ['utils/windowBounds', 'windowBounds'],
    ['startup/quitCleanup', 'quitCleanup'],
  ])
    entry = entry.replace(`../../packages/desktop/src/process/${original}`, `./${replacement}`);
  fs.writeFileSync(path.join(baseline, 'entry.ts'), entry);
  build(path.join(baseline, 'entry.ts'), 'baseline.cjs');
  fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ baseline: values.baseline }, null, 2));
}
if (!values['prepare-only']) {
  const runs = Number(values.runs);
  assert.ok(Number.isSafeInteger(runs) && runs > 0);
  const electron = values.electron ?? createRequire(path.join(root, 'package.json'))('electron');
  const report = {
    baseline: JSON.parse(fs.readFileSync(path.join(output, 'build.json'), 'utf8')).baseline,
    runs,
    modes: {},
    iterations: [],
  };
  const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  for (const mode of ['baseline', 'fixed']) {
    const counters = { emptyFiles: 0, smokeFailures: 0, exitFailures: 0 };
    report.modes[mode] = counters;
    for (let launch = 1; launch <= runs; launch++) {
      const file = path.join(output, `${mode}-config.txt`);
      // Each independent experiment starts from false. There is no reseeding
      // inside an app session; the installed smoke never reseeds on restart.
      fs.writeFileSync(file, btoa(encodeURIComponent(JSON.stringify({ 'update.autoCheck': false }))));
      const env = { ...process.env, CONFIG_PERSIST_FILE: file };
      delete env.DEBUG;
      const result = spawnSync(
        electron,
        [...(values['no-sandbox'] ? ['--no-sandbox'] : []), '--disable-gpu', path.join(output, `${mode}.cjs`)],
        { env, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] }
      );
      let evidence;
      try {
        verifyConfigPreserved(file, {
          phase: 'after-os-exit',
          launch,
          record: (row) => {
            evidence = row;
          },
        });
      } catch {
        counters.smokeFailures++;
      }
      if (evidence.bytes === 0) counters.emptyFiles++;
      if (result.status !== 0) counters.exitFailures++;
      report.iterations.push({ mode, exitCode: result.status, signal: result.signal, ...evidence });
      save();
      assert.equal(result.status, 0, `Electron failed: ${result.stderr || result.error}`);
    }
    console.log(JSON.stringify({ mode, runs, ...counters }));
  }
  assert.ok(report.modes.baseline.emptyFiles > 0, 'Baseline did not reproduce; do not claim a fixed comparison');
  assert.equal(report.modes.fixed.smokeFailures, 0, 'Fixed code lost the preference');
}
