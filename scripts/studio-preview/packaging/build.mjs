/** Build the current host's Provider acceptance installer; never publish or notarize it. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { build, Platform, Arch } = require('electron-builder');
const yaml = require('js-yaml');
const { prepareAioncore } = require('../../../packages/shared-scripts/src/prepare-aioncore.js');
const root = path.resolve(import.meta.dirname, '../../..');
const index = process.argv.indexOf('--runtime');
const runtime = index >= 0 ? path.resolve(process.argv[index + 1]) : path.join(root, '.local/studio-preview');
const target = `${process.platform}-${process.arch}`;
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'scripts/studio-preview/baseline.json')));
if (!baseline.aioncore.assets[target]) throw new Error('Host has no declared Preview runtime target');
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? path.resolve(process.argv[at + 1]) : fallback;
};
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error('Installer preparation failed');
};
const payload = option('--payload', path.join(root, '.local/packaging/runtime'));
if (!fs.existsSync(payload))
  run(path.join(runtime, 'native', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])), [
    '-B',
    path.join(import.meta.dirname, 'bundle.py'),
    '--runtime',
    runtime,
    '--output',
    payload,
  ]);
const manifest = JSON.parse(fs.readFileSync(path.join(payload, 'manifest.json')));
if (manifest.schema !== 'aelix.studio-preview.runtime/1' || manifest.target !== target || manifest.nativePatches.length)
  throw new Error('Invalid Preview payload');
const { createHash } = await import('node:crypto');
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (
  manifest.baselineSha256 !== digest(path.join(root, 'scripts/studio-preview/baseline.json')) ||
  manifest.preparedReceiptSha256 !== digest(path.join(runtime, 'receipt.json'))
)
  throw new Error('Stale payload: archive the owned .local/packaging/runtime and rebuild');
for (const [name, source] of [
  ...['bundle.py', 'launch.py', 'build.mjs', 'native-requirements.lock'].map((name) => [
    name,
    path.join(import.meta.dirname, name),
  ]),
  ['launch.cjs', path.join(import.meta.dirname, '../host-forwarding/launch.cjs')],
])
  if (manifest.recipeSha256?.[name] !== digest(source))
    throw new Error('Stale payload recipe: archive the owned .local/packaging/runtime and rebuild');
const inventory = JSON.parse(fs.readFileSync(path.join(payload, 'checksums.json')));
const current = fs
  .readdirSync(payload, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() || entry.isSymbolicLink())
  .map((entry) => path.relative(payload, path.join(entry.parentPath, entry.name)))
  .filter((relative) => relative !== 'checksums.json')
  .sort();
if (JSON.stringify(current) !== JSON.stringify(Object.keys(inventory).sort()))
  throw new Error('Preview payload inventory changed');
for (const [relative, expected] of Object.entries(inventory)) {
  const file = path.resolve(payload, relative);
  if (!file.startsWith(payload + path.sep) || !fs.realpathSync(file).startsWith(payload + path.sep))
    throw new Error('Preview payload path escaped');
  if (expected.startsWith('symlink:')) {
    if (
      !fs.lstatSync(file).isSymbolicLink() ||
      path.isAbsolute(fs.readlinkSync(file)) ||
      fs.readlinkSync(file) !== expected.slice(8)
    )
      throw new Error('Preview payload symlink changed');
  } else if (!fs.lstatSync(file).isFile() || digest(file) !== expected)
    throw new Error('Preview payload bytes changed');
}
if (process.argv.includes('--verify-only')) {
  console.log('Preview payload identity and inventory verified');
  process.exit(0);
}
run('bun', ['run', 'package']);
run('node', ['scripts/build-mcp-servers.js']);
prepareAioncore({
  projectRoot: root,
  platform: process.platform,
  arch: process.arch,
  version: require('../../../package.json').aioncoreVersion,
});
const prepared = JSON.parse(fs.readFileSync(path.join(runtime, 'receipt.json')));
if (
  digest(
    path.join(root, 'resources/bundled-aioncore', target, process.platform === 'win32' ? 'aioncore.exe' : 'aioncore')
  ) !== prepared.aioncoreBinarySha256
)
  throw new Error('Prepared packaging host differs from the qualified public AionCore');
run('node', ['scripts/prepareHubResources.js']);
const config = yaml.load(fs.readFileSync(path.join(root, 'packages/desktop/electron-builder.yml'), 'utf8'));
config.extraResources.push({ from: payload, to: 'studio-preview' });
config.directories.output = option('--output', path.join(root, '.local/provider-installer/artifacts'));
config.electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
config.mac = { ...config.mac, identity: '-', notarize: false };
config.win = { ...config.win, signAndEditExecutable: false };
config.nsis = {
  ...config.nsis,
  perMachine: false,
  runAfterFinish: false,
  createDesktopShortcut: false,
  createStartMenuShortcut: false,
};
config.afterSign = undefined;
delete config.electronDownload;
const platform = { darwin: Platform.MAC, linux: Platform.LINUX, win32: Platform.WINDOWS }[process.platform];
const formats = { darwin: ['dmg', 'zip'], linux: ['deb'], win32: ['nsis'] }[process.platform];
await build({
  targets: platform.createTarget(formats, process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
  config,
  publish: 'never',
});
