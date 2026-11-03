/** Prepare only the checksum-pinned Studio host release and its managed resources. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { verifyBundledAioncoreResources } = require('./verify-bundled-aioncore-resources');
const { policy } = require('./default-host');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}
function removeDirectorySafe(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

function prepareManagedResources(binaryPath, targetDir) {
  const bundleOut = path.join(targetDir, 'managed-resources');
  const dataDir = path.join(targetDir, '.prepare-data');

  removeDirectorySafe(bundleOut);
  removeDirectorySafe(dataDir);
  ensureDirectory(bundleOut);
  ensureDirectory(dataDir);

  console.log(`  Preparing managed resources under ${path.relative(process.cwd(), bundleOut)}`);
  execFileSync(binaryPath, ['--data-dir', dataDir, 'prepare-managed-resources', '--bundle-out', bundleOut], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AIONUI_BUNDLED_MANAGED_RESOURCES: '',
    },
  });

  removeDirectorySafe(dataDir);
  return bundleOut;
}

function verifyPreparedAioncoreBundle(projectRoot, platform, arch) {
  const result = verifyBundledAioncoreResources({
    resourcesDir: path.join(projectRoot, 'resources'),
    electronPlatformName: platform,
    targetArch: arch,
  });
  if (result.missing.length > 0 || result.failures.length > 0) {
    const summary = result.missing.length > 0 ? result.missing.join(', ') : JSON.stringify(result.failures);
    throw new Error(`Prepared aioncore bundle is missing required bundled resource(s): ${summary}`);
  }
  return result;
}

/** Return the archive name from the exact release policy, with no tag rewriting. */
function getAssetName(platform, arch, tag) {
  if (tag !== policy.tag) throw new Error('Host version differs from the pinned release');
  return policy.targets[`${platform}-${arch}`]?.archive ?? null;
}

/** Prepare the pinned release; absent or unknown policies never enable fallback downloads. */
function prepareAioncore(options) {
  const { projectRoot, platform, arch, version } = options;
  const packageFile = path.join(projectRoot, 'package.json');
  const sourcePolicy =
    fs.existsSync(packageFile) && JSON.parse(fs.readFileSync(packageFile, 'utf8')).aioncoreSourcePolicy;
  if (!sourcePolicy) throw new Error('Studio host release policy is required');
  if (sourcePolicy !== 'scripts/studio-preview/host-release/default.json')
    throw new Error('Unknown Studio host source policy');
  if (version !== undefined && version !== policy.tag) throw new Error('Host version differs from the pinned release');
  const { prepareDefaultHost } = require(path.join(projectRoot, 'scripts/studio-preview/host-release/prepare.cjs'));
  const result = prepareDefaultHost({ ...options, prepareManagedResources });
  verifyPreparedAioncoreBundle(projectRoot, platform, arch);
  return result;
}

module.exports = { prepareManagedResources, getAssetName, prepareAioncore, verifyPreparedAioncoreBundle };
