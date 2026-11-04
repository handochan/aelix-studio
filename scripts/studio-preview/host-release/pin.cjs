/** Generate all Studio host pins from one immutable release; never publish a release. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const repository = 'handochan/aelix-studio-host';
const root = path.resolve(__dirname, '../../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];

/** Validate release identity and every asset digest before changing any pin. */
function releasePolicy(tag, release, provenanceBytes, checksums, commit) {
  if (!/^host-v\d+\.\d+\.\d+-aelix\.\d+$/.test(tag)) throw new Error('An exact host release tag is required');
  if (release.tag_name !== tag || !release.immutable || release.draft || release.prerelease)
    throw new Error('Host release must be published, stable and immutable');
  const provenance = JSON.parse(provenanceBytes);
  if (
    provenance.schema !== 'aelix-studio-host.release-provenance/1' ||
    provenance.kind !== 'release' ||
    provenance.label !== tag ||
    provenance.repository !== repository ||
    provenance.commit !== commit.sha ||
    provenance.tree !== commit.commit.tree.sha
  )
    throw new Error('Host release provenance differs from the tagged commit/tree');
  const sums = new Map(
    checksums
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const match = /^([a-f0-9]{64})  ([\w.-]+)$/.exec(line);
        if (!match) throw new Error('Malformed release checksum');
        return [match[2], match[1]];
      })
  );
  const assertDigest = (name, expected) => {
    const asset = release.assets.find((item) => item.name === name);
    if (!asset || asset.digest !== `sha256:${expected}` || sums.get(name) !== expected)
      throw new Error(`Release asset digest differs: ${name}`);
  };
  const provenanceFile = `aelix-studio-host-${tag.slice(6)}-provenance.json`;
  assertDigest(provenanceFile, hash(provenanceBytes));
  if (JSON.stringify(Object.keys(provenance.targets).sort()) !== JSON.stringify([...targets].sort()))
    throw new Error('Host release must contain exactly the five supported targets');
  for (const target of targets) {
    const spec = provenance.targets[target];
    if (
      !spec.archive.startsWith(`aelix-studio-host-${tag.slice(6)}-`) ||
      !/^[a-f0-9]{64}$/.test(spec.binarySha256) ||
      !/^[a-f0-9]{64}$/.test(spec.binaryCodeSha256) ||
      spec.smoke?.status !== 'passed'
    )
      throw new Error(`Invalid target provenance: ${target}`);
    assertDigest(spec.archive, spec.archiveSha256);
  }
  return {
    ...Object.fromEntries(
      [
        'repository',
        'commit',
        'tree',
        'upstream',
        'rustToolchain',
        'cargoLockSha256',
        'licenseSha256',
        'noticeSha256',
      ].map((key) => [key, provenance[key]])
    ),
    schema: 'aelix-studio.host-release/1',
    tag,
    provenanceFile,
    provenanceSha256: hash(provenanceBytes),
    targets: provenance.targets,
  };
}

function pinRelease(tag) {
  const gh = (args) => execFileSync('gh', args, { maxBuffer: 4 * 1024 * 1024 });
  // Validate the tag before using it as part of an API path or an asset name.
  if (!/^host-v\d+\.\d+\.\d+-aelix\.\d+$/.test(tag)) throw new Error('An exact host release tag is required');
  const release = JSON.parse(gh(['api', `repos/${repository}/releases/tags/${tag}`]));
  const asset = (name) => {
    const selected = release.assets.find((item) => item.name === name);
    if (!selected) throw new Error(`Missing release asset: ${name}`);
    const bytes = gh([
      'api',
      '-H',
      'Accept: application/octet-stream',
      `repos/${repository}/releases/assets/${selected.id}`,
    ]);
    if (selected.digest !== `sha256:${hash(bytes)}`) throw new Error(`Downloaded asset digest differs: ${name}`);
    return bytes;
  };
  const provenanceBytes = asset(`aelix-studio-host-${tag.slice(6)}-provenance.json`);
  const checksums = asset('aelix-studio-host-checksums.txt').toString('utf8');
  const commit = JSON.parse(gh(['api', `repos/${repository}/commits/${tag}`]));
  const policy = releasePolicy(tag, release, provenanceBytes, checksums, commit);
  const format = (relative, value) =>
    execFileSync(path.join(root, 'node_modules/.bin/oxfmt'), ['--stdin-filepath', relative], {
      input: JSON.stringify(value, null, 2) + '\n',
      maxBuffer: 4 * 1024 * 1024,
    });
  const defaultPath = 'scripts/studio-preview/host-release/default.json';
  const defaultBytes = format(defaultPath, policy);
  const baselinePath = 'scripts/studio-preview/baseline.json';
  const baseline = JSON.parse(fs.readFileSync(path.join(root, baselinePath)));
  baseline.aioncore = {
    ...Object.fromEntries(
      ['repository', 'tag', 'commit', 'tree', 'provenanceFile', 'provenanceSha256'].map((key) => [key, policy[key]])
    ),
    assets: Object.fromEntries(
      targets.map((target) => [
        target,
        { filename: policy.targets[target].archive, sha256: policy.targets[target].archiveSha256 },
      ])
    ),
    sourceManifestSha256: hash(defaultBytes),
  };
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  pkg.aioncoreVersion = tag;
  // Compute and format every output before replacing files. Provenance stays byte-for-byte published.
  const outputs = new Map([
    [defaultPath, defaultBytes],
    ['scripts/studio-preview/host-release/provenance.json', provenanceBytes],
    [baselinePath, format(baselinePath, baseline)],
    ['package.json', format('package.json', pkg)],
  ]);
  for (const [relative, bytes] of outputs) {
    const file = path.join(root, relative);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, bytes);
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  console.log(`${tag}: generated four pin files at ${policy.commit}; source manifest ${hash(defaultBytes)}`);
}
module.exports = { releasePolicy };
if (require.main === module) pinRelease(process.argv[2]);
