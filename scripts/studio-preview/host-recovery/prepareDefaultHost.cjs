/** Build the pinned default host on a native runner; never fall back to released bytes. */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  policy,
  digest,
  codeIdentity,
  inventory,
  stable,
  verifyDefaultHostBundle,
} = require('../../../packages/shared-scripts/src/default-host.js');

function defaultHostCacheKey(policyHash, recipeHash, target) {
  // MSVC object outputs hit MAX_PATH when the full policy/recipe digest is in
  // every path. Keep the Windows locator short; receipts still verify all bits.
  return target.startsWith('win32-')
    ? target + '-' + policyHash.slice(0, 20)
    : policyHash + '-' + recipeHash.slice(0, 16) + '-' + target;
}

function prepareDefaultHost({ projectRoot, platform, arch, python }) {
  const target = `${platform}-${arch}`;
  if (!policy.targets[target] || target !== `${process.platform}-${process.arch}`)
    throw new Error('Default host requires a supported native runner');
  const here = path.join(projectRoot, 'scripts/studio-preview/host-recovery');
  const manifest = path.join(here, 'default.json');
  const recipe = path.join(here, 'build.py');
  const { createHash } = require('node:crypto');
  const policyHash = createHash('sha256').update(stable(policy)).digest('hex');
  const key = defaultHostCacheKey(policyHash, digest(recipe), target);
  const cache = path.join(projectRoot, '.local/default-host', key);
  const output = path.join(cache, 'build');
  const executable = platform === 'win32' ? 'aioncore.exe' : 'aioncore';
  python = python || process.env.STUDIO_HOST_BUILD_PYTHON || (platform === 'win32' ? 'python' : 'python3');
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, 'source.tar.gz');
  if (!fs.existsSync(archive)) {
    execFileSync(
      python,
      [
        '-I',
        '-B',
        '-c',
        'import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1],sys.argv[2])',
        policy.upstream.archiveUrl,
        archive,
      ],
      { stdio: 'inherit' }
    );
  }
  if (digest(archive) !== policy.upstream.archiveSha256) throw new Error('Default host source archive changed');
  if (!fs.existsSync(output)) {
    execFileSync(
      python,
      [
        '-I',
        '-B',
        recipe,
        '--manifest',
        manifest,
        '--target',
        target,
        '--archive',
        archive,
        '--output',
        output,
        '--target-dir',
        path.join(cache, 'cargo-target'),
      ],
      { cwd: projectRoot, stdio: 'inherit' }
    );
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(output, 'build-receipt.json'), 'utf8'));
  if (
    receipt.status !== 'built_candidate' ||
    receipt.sourcePolicySha256 !== policyHash ||
    receipt.buildRecipeSha256 !== digest(recipe) ||
    receipt.binarySha256 !== digest(path.join(output, executable))
  )
    throw new Error('Stale or incomplete default host build; archive this owned cache and rebuild');
  const directory = path.join(projectRoot, 'resources/bundled-aioncore', target);
  if (fs.existsSync(directory)) {
    const existing = verifyDefaultHostBundle(directory, target);
    if (existing.buildReceiptSha256 !== digest(path.join(output, 'build-receipt.json')))
      throw new Error('Default host bundle belongs to a different build; archive it and rebuild');
    return { prepared: true, dir: directory, sourceType: existing.sourceType };
  }
  fs.mkdirSync(directory, { recursive: true });
  for (const file of [executable, 'build-receipt.json', 'AIONCORE-LICENSE.txt'])
    fs.copyFileSync(path.join(output, file), path.join(directory, file));
  if (platform !== 'win32') fs.chmodSync(path.join(directory, executable), 0o755);
  fs.cpSync(path.join(output, 'managed-resources'), path.join(directory, 'managed-resources'), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const result = {
    platform,
    arch,
    version: policy.upstream.tag,
    sourceType: 'studio-default-source',
    hostPolicy: policy,
    source: policy.upstream.repository + '@' + policy.upstream.commit,
    files: [executable, 'managed-resources/', 'build-receipt.json', 'AIONCORE-LICENSE.txt'],
    buildReceiptSha256: digest(path.join(directory, 'build-receipt.json')),
    binaryCodeSha256: codeIdentity(fs.readFileSync(path.join(directory, executable))),
    inventory: inventory(directory),
  };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
  verifyDefaultHostBundle(directory, target);
  return { prepared: true, dir: directory, sourceType: result.sourceType };
}
module.exports = { prepareDefaultHost, defaultHostCacheKey };

if (require.main === module) {
  require('../../../packages/shared-scripts/src/prepare-aioncore.js').prepareAioncore({
    projectRoot: path.resolve(__dirname, '../../..'),
    platform: process.platform,
    arch: process.arch,
  });
}
