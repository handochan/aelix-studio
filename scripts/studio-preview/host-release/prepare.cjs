/** Download the exact host release; never build or patch host source in Studio. */
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
const { createHash, randomUUID } = require('node:crypto');

/** Publish an archive to its cache only after the complete download matches its pin. */
function downloadVerifiedArchive(
  url,
  archive,
  expected,
  download = (source, destination) => {
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '--output', destination, source], {
      stdio: 'inherit',
    });
  }
) {
  if (fs.existsSync(archive)) {
    if (digest(archive) !== expected) throw new Error('Default host release archive checksum differs');
    return;
  }
  const temporary = archive + '.' + process.pid + '.' + randomUUID() + '.partial';
  try {
    download(url, temporary);
    if (digest(temporary) !== expected) throw new Error('Default host release archive checksum differs');
    fs.renameSync(temporary, archive);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function prepareDefaultHost({ projectRoot, platform, arch, prepareManagedResources }) {
  const target = `${platform}-${arch}`;
  const spec = policy.targets[target];
  if (!spec || target !== `${process.platform}-${process.arch}`)
    throw new Error('Default host requires a supported native runner');
  const directory = path.join(projectRoot, 'resources/bundled-aioncore', target);
  if (fs.existsSync(directory)) {
    const existing = verifyDefaultHostBundle(directory, target);
    return { prepared: true, dir: directory, sourceType: existing.sourceType };
  }
  const cache = path.join(projectRoot, '.local/default-host', policy.tag, target);
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, spec.archive);
  const url = `https://github.com/${policy.repository}/releases/download/${policy.tag}/${spec.archive}`;
  downloadVerifiedArchive(url, archive, spec.archiveSha256);
  const extracted = path.join(cache, 'extracted');
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted);
  if (platform === 'win32') {
    const quote = (value) => value.replace(/'/g, "''");
    execFileSync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${quote(archive)}' -DestinationPath '${quote(extracted)}'`,
    ]);
  } else execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  // The checksum authenticates every archive member before extraction or execution.
  if (digest(path.join(extracted, spec.binary)) !== spec.binarySha256)
    throw new Error('Default host release binary checksum differs');
  fs.copyFileSync(
    path.join(projectRoot, 'scripts/studio-preview/host-release/provenance.json'),
    path.join(extracted, 'release-provenance.json')
  );
  if (platform !== 'win32') fs.chmodSync(path.join(extracted, spec.binary), 0o755);
  // Managed Node is prepared at build time by the released host.
  prepareManagedResources(path.join(extracted, spec.binary), extracted);
  const manifest = {
    platform,
    arch,
    version: policy.tag,
    sourceType: 'studio-host-release',
    hostPolicy: policy,
    source: `${policy.repository}@${policy.commit}`,
    archiveSha256: spec.archiveSha256,
    buildReceiptSha256: digest(path.join(extracted, 'build-receipt.json')),
    binaryCodeSha256: codeIdentity(fs.readFileSync(path.join(extracted, spec.binary))),
    managedResourcesSha256: createHash('sha256')
      .update(stable(inventory(path.join(extracted, 'managed-resources'), { excludeManifest: false })))
      .digest('hex'),
    inventory: inventory(extracted),
  };
  fs.writeFileSync(path.join(extracted, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  verifyDefaultHostBundle(extracted, target);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.cpSync(extracted, directory, { recursive: true, verbatimSymlinks: true });
  verifyDefaultHostBundle(directory, target);
  return { prepared: true, dir: directory, sourceType: manifest.sourceType };
}
module.exports = { prepareDefaultHost, downloadVerifiedArchive };

if (require.main === module)
  require('../../../packages/shared-scripts/src/prepare-aioncore.js').prepareAioncore({
    projectRoot: path.resolve(__dirname, '../../..'),
    platform: process.platform,
    arch: process.arch,
  });
