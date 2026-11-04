import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const {
  policy,
  codeIdentity,
  inventory,
  stable,
  verifyDefaultHostBundle,
} = require('../../../packages/shared-scripts/src/default-host.js');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
let root: string, directory: string, receipt: Record<string, unknown>, manifest: Record<string, unknown>;
const writeJson = (name: string, value: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
function refreshManifest() {
  manifest.buildReceiptSha256 = hash(fs.readFileSync(path.join(directory, 'build-receipt.json')));
  manifest.inventory = inventory(directory);
  writeJson('manifest.json', manifest);
}

const originalPolicy = structuredClone(policy);
beforeEach(() => {
  Object.assign(policy, structuredClone(originalPolicy));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-default-host-'));
  directory = path.join(root, 'bundled-aioncore/win32-x64');
  fs.mkdirSync(path.join(directory, 'managed-resources/node'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'aelix-studio-host.exe'), 'synthetic non-executable fixture');
  fs.copyFileSync('LICENSE', path.join(directory, 'LICENSE'));
  fs.writeFileSync(path.join(directory, 'NOTICE'), 'synthetic notice');
  fs.writeFileSync(path.join(directory, 'managed-resources/node/node.exe'), 'synthetic node fixture');
  writeJson('managed-resources/manifest.json', {
    schemaVersion: 2,
    runtimeKey: 'win32-x64',
    node: { version: '24.11.0', root: 'node', executable: 'node.exe' },
    clis: [],
  });
  const binaryHash = hash(fs.readFileSync(path.join(directory, 'aelix-studio-host.exe')));
  policy.targets['win32-x64'].binarySha256 = binaryHash;
  policy.targets['win32-x64'].binaryCodeSha256 = binaryHash;
  policy.licenseSha256 = hash(fs.readFileSync('LICENSE'));
  policy.noticeSha256 = hash('synthetic notice');
  const provenance = {
    schema: 'aelix-studio-host.release-provenance/1',
    kind: 'release',
    label: policy.tag,
    repository: policy.repository,
    commit: policy.commit,
    tree: policy.tree,
    targets: policy.targets,
  };
  writeJson('release-provenance.json', provenance);
  policy.provenanceSha256 = hash(fs.readFileSync(path.join(directory, 'release-provenance.json')));
  receipt = {
    schema: 'aelix-studio-host.build-receipt/1',
    status: 'built',
    dirty: false,
    repository: policy.repository,
    commit: policy.commit,
    tree: policy.tree,
    label: policy.tag,
    target: 'win32-x64',
    binary: 'aelix-studio-host.exe',
    archive: policy.targets['win32-x64'].archive,
    binarySha256: binaryHash,
    binaryCodeSha256: binaryHash,
    rustToolchain: policy.rustToolchain,
    profile: 'release',
    upstream: { repository: policy.upstream.repository, tag: policy.upstream.tag, commit: policy.upstream.commit },
    cargoLockSha256: policy.cargoLockSha256,
    licenseSha256: policy.licenseSha256,
    noticeSha256: policy.noticeSha256,
  };
  writeJson('build-receipt.json', receipt);
  manifest = {
    platform: 'win32',
    arch: 'x64',
    sourceType: 'studio-host-release',
    hostPolicy: policy,
    managedResourcesSha256: hash(
      stable(inventory(path.join(directory, 'managed-resources'), { excludeManifest: false }))
    ),
  };
  refreshManifest();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  Object.assign(policy, structuredClone(originalPolicy));
});

describe('default host launch provenance', () => {
  it('accepts the pinned release receipt and complete resources', () => {
    expect(verifyDefaultHostBundle(directory, 'win32-x64').sourceType).toBe('studio-host-release');
  });
  it('rejects a changed release provenance even with a refreshed local inventory', () => {
    writeJson('release-provenance.json', { commit: 'unreviewed' });
    refreshManifest();
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow('release provenance changed');
  });
  it('rejects a receipt for another source commit even with a refreshed local inventory', () => {
    receipt.commit = '0'.repeat(40);
    writeJson('build-receipt.json', receipt);
    refreshManifest();
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow('build provenance differs');
  });
  it('accepts the released GLIBC prefix and rejects a newer or malformed Linux ABI', () => {
    const spec = policy.targets['linux-arm64'];
    spec.binarySha256 = receipt.binarySha256;
    spec.binaryCodeSha256 = receipt.binaryCodeSha256;
    fs.renameSync(path.join(directory, 'aelix-studio-host.exe'), path.join(directory, 'aelix-studio-host'));
    Object.assign(receipt, {
      target: 'linux-arm64',
      binary: spec.binary,
      archive: spec.archive,
      buildContainer: spec.buildContainer,
      maximumGlibcVersionNeeded: 'GLIBC_2.30',
    });
    Object.assign(manifest, { platform: 'linux', arch: 'arm64' });
    const resourceFile = path.join(directory, 'managed-resources/manifest.json');
    const resources = JSON.parse(fs.readFileSync(resourceFile, 'utf8'));
    resources.runtimeKey = 'linux-arm64';
    fs.writeFileSync(resourceFile, JSON.stringify(resources));
    manifest.managedResourcesSha256 = hash(
      stable(inventory(path.join(directory, 'managed-resources'), { excludeManifest: false }))
    );
    const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'release-provenance.json'), 'utf8'));
    provenance.targets = policy.targets;
    writeJson('release-provenance.json', provenance);
    policy.provenanceSha256 = hash(fs.readFileSync(path.join(directory, 'release-provenance.json')));
    const check = () => {
      writeJson('build-receipt.json', receipt);
      refreshManifest();
      return verifyDefaultHostBundle(directory, 'linux-arm64');
    };
    expect(check().sourceType).toBe('studio-host-release');
    receipt.maximumGlibcVersionNeeded = 'GLIBC_2.39';
    expect(check).toThrow('GLIBC compatibility differs');
    receipt.maximumGlibcVersionNeeded = '2.30';
    expect(check).toThrow('GLIBC compatibility differs');
  });
  it.runIf(process.platform === 'win32')('verifies a Windows namespaced install path', () => {
    expect(verifyDefaultHostBundle(path.toNamespacedPath(directory), 'win32-x64').sourceType).toBe(
      'studio-host-release'
    );
  });
  it('rejects a resource directory junction or symlink escaping the native canonical root', () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'extra'), 'outside fixture');
    fs.symlinkSync(
      outside,
      path.join(directory, 'managed-resources/outside'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect(() => inventory(directory)).toThrow('resource escapes its bundle');
  });
  it('rejects replacement code even when the mutable bundle inventory is refreshed', () => {
    fs.writeFileSync(path.join(directory, 'aelix-studio-host.exe'), 'replacement code');
    manifest.binaryCodeSha256 = hash('replacement code');
    refreshManifest();
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow('code or upstream license changed');
  });
  it('rejects missing managed resources even with a self-consistent inventory', () => {
    fs.rmSync(path.join(directory, 'managed-resources'), { recursive: true });
    refreshManifest();
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow();
  });
  it('rejects replacement managed Node bytes even when the mutable inventory is refreshed', () => {
    fs.writeFileSync(path.join(directory, 'managed-resources/node/node.exe'), 'replacement node');
    refreshManifest();
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow(
      'managed resources differ from the build receipt'
    );
  });
  it('rejects an old toolchain receipt with a refreshed receipt hash', () => {
    receipt.rustToolchain = '1.94.0';
    writeJson('build-receipt.json', receipt);
    refreshManifest();
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow('build provenance differs');
  });
  it('rejects extra unmanaged executable resources', () => {
    fs.writeFileSync(path.join(directory, 'surprise.exe'), 'extra');
    expect(() => verifyDefaultHostBundle(directory, 'win32-x64')).toThrow('inventory changed');
  });
  it('normalizes only the bounded Mach-O signature and retains changed code bytes', () => {
    const original = Buffer.alloc(144);
    original.writeUInt32LE(0xfeedfacf, 0);
    original.writeUInt32LE(1, 16);
    original.writeUInt32LE(72, 20);
    original.writeUInt32LE(0x19, 32);
    original.writeUInt32LE(72, 36);
    original.write('__LINKEDIT', 40);
    original.writeBigUInt64LE(16n, 64);
    original.writeBigUInt64LE(128n, 72);
    original.writeBigUInt64LE(16n, 80);
    original.write('retained code', 128);
    const signed = Buffer.concat([original, Buffer.alloc(28)]);
    signed.writeUInt32LE(2, 16);
    signed.writeUInt32LE(88, 20);
    signed.writeBigUInt64LE(44n, 64);
    signed.writeBigUInt64LE(44n, 80);
    signed.writeUInt32LE(0x1d, 104);
    signed.writeUInt32LE(16, 108);
    signed.writeUInt32LE(144, 112);
    signed.writeUInt32LE(28, 116);
    signed.writeUInt32BE(0xfade0cc0, 144);
    signed.writeUInt32BE(28, 148);
    signed.writeUInt32BE(1, 152);
    signed.writeUInt32BE(20, 160);
    signed.writeUInt32BE(8, 168);
    expect(codeIdentity(signed)).toBe(codeIdentity(original));
    signed[128] ^= 1;
    expect(codeIdentity(signed)).not.toBe(codeIdentity(original));
  });
});

describe('release archive selection', () => {
  it('uses the normalized immutable host release archive name', () => {
    const { getAssetName } = require('../../../packages/shared-scripts/src/prepare-aioncore.js');
    expect(getAssetName('darwin', 'arm64', policy.tag)).toBe(policy.targets['darwin-arm64'].archive);
    expect(getAssetName('win32', 'x64', policy.tag)).toBe(policy.targets['win32-x64'].archive);
    expect(getAssetName('unsupported', 'x64', policy.tag)).toBeNull();
  });
  it('refuses a changed cached release archive before extraction or execution', () => {
    const { prepareDefaultHost } = require('../../../scripts/studio-preview/host-release/prepare.cjs');
    const target = `${process.platform}-${process.arch}`;
    if (!policy.targets[target]) return;
    const cache = path.join(root, '.local/default-host', policy.tag, target);
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, policy.targets[target].archive), 'changed bytes');
    expect(() => prepareDefaultHost({ projectRoot: root, platform: process.platform, arch: process.arch })).toThrow(
      'release archive checksum differs'
    );
  });
});

describe('verified archive publication', () => {
  it('removes an interrupted download and permits a fresh verified retry', () => {
    const { downloadVerifiedArchive } = require('../../../scripts/studio-preview/host-release/prepare.cjs');
    const archive = path.join(root, 'release.tar.gz');
    const interrupted = (_url: string, temporary: string) => {
      fs.writeFileSync(temporary, 'partial');
      throw new Error('interrupted');
    };
    expect(() => downloadVerifiedArchive('https://fixture.invalid', archive, hash('complete'), interrupted)).toThrow(
      'interrupted'
    );
    expect(fs.readdirSync(root).filter((name: string) => name.includes('release.tar.gz'))).toEqual([]);
    downloadVerifiedArchive('https://fixture.invalid', archive, hash('complete'), (_url: string, temporary: string) =>
      fs.writeFileSync(temporary, 'complete')
    );
    expect(fs.readFileSync(archive, 'utf8')).toBe('complete');
  });
  it('never publishes bytes that differ from the archive pin', () => {
    const { downloadVerifiedArchive } = require('../../../scripts/studio-preview/host-release/prepare.cjs');
    const archive = path.join(root, 'release.tar.gz');
    expect(() =>
      downloadVerifiedArchive('https://fixture.invalid', archive, hash('expected'), (_url: string, temporary: string) =>
        fs.writeFileSync(temporary, 'wrong')
      )
    ).toThrow('checksum differs');
    expect(fs.existsSync(archive)).toBe(false);
    expect(fs.readdirSync(root).filter((name: string) => name.endsWith('.partial'))).toEqual([]);
  });
});

describe('release pin generation', () => {
  const { releasePolicy } = require('../../../scripts/studio-preview/host-release/pin.cjs');
  const bytes = fs.readFileSync('scripts/studio-preview/host-release/provenance.json');
  const provenance = JSON.parse(bytes.toString());
  const pinned = JSON.parse(fs.readFileSync('scripts/studio-preview/host-release/default.json', 'utf8'));
  const assets = [
    { name: pinned.provenanceFile, digest: `sha256:${hash(bytes)}` },
    ...Object.values(provenance.targets).map((item) => {
      const spec = item as { archive: string; archiveSha256: string };
      return { name: spec.archive, digest: `sha256:${spec.archiveSha256}` };
    }),
  ];
  const release = { tag_name: provenance.label, immutable: true, draft: false, prerelease: false, assets };
  const checksums = assets.map((item) => `${item.digest.slice(7)}  ${item.name}`).join('\n');
  const commit = { sha: provenance.commit, commit: { tree: { sha: provenance.tree } } };
  it('regenerates the committed policy from the immutable release inputs', () => {
    expect(releasePolicy(provenance.label, release, bytes, checksums, commit)).toEqual(pinned);
  });
  it('keeps all four pin files and the final formatted manifest hash consistent', () => {
    const baseline = JSON.parse(fs.readFileSync('scripts/studio-preview/baseline.json', 'utf8'));
    expect(baseline.aioncore.sourceManifestSha256).toBe(
      hash(fs.readFileSync('scripts/studio-preview/host-release/default.json'))
    );
    expect(require('../../../package.json').aioncoreVersion).toBe(pinned.tag);
    expect(baseline.aioncore.provenanceSha256).toBe(hash(bytes));
  });
  it.each([
    [{ ...release, immutable: false }, checksums, commit],
    [release, checksums.replace(assets[1].digest.slice(7), '0'.repeat(64)), commit],
    [release, checksums, { ...commit, sha: '0'.repeat(40) }],
  ])('rejects mutable releases, mismatched digests or tag identities', (metadata, sums, source) => {
    expect(() => releasePolicy(provenance.label, metadata, bytes, sums, source)).toThrow();
  });
  it('rejects latest and rewritten upstream tags', () => {
    expect(() => releasePolicy('latest', release, bytes, checksums, commit)).toThrow('exact host release');
  });
});
