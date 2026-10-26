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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-default-host-'));
  directory = path.join(root, 'bundled-aioncore/win32-x64');
  fs.mkdirSync(path.join(directory, 'managed-resources/node'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'aioncore.exe'), 'synthetic non-executable fixture');
  fs.copyFileSync('LICENSE', path.join(directory, 'AIONCORE-LICENSE.txt'));
  fs.writeFileSync(path.join(directory, 'managed-resources/node/node.exe'), 'synthetic node fixture');
  writeJson('managed-resources/manifest.json', {
    schemaVersion: 2,
    runtimeKey: 'win32-x64',
    node: { version: '24.11.0', root: 'node', executable: 'node.exe' },
    clis: [],
  });
  const binaryHash = hash(fs.readFileSync(path.join(directory, 'aioncore.exe')));
  receipt = {
    status: 'built_candidate',
    purpose: 'default_runtime',
    target: 'win32-x64',
    binary: 'aioncore.exe',
    profile: 'release',
    sourcePolicySha256: hash(stable(policy)),
    buildRecipeSha256: policy.buildRecipeSha256,
    identityRecipeSha256: policy.identityRecipeSha256,
    managedResourceRecipeSha256: policy.managedResourceRecipeSha256,
    resourceIdentityRecipeSha256: policy.resourceIdentityRecipeSha256,
    managedResourcesSha256: hash(
      stable(inventory(path.join(directory, 'managed-resources'), { excludeManifest: false }))
    ),
    patchSha256: policy.patch.sha256,
    upstream: policy.upstream,
    cargoLockSha256: policy.cargoLockSha256,
    licenseFileSha256: policy.upstreamLicenseSha256,
    releasedHostBytes: false,
    nativePatches: [],
    originalSourceFilesVerified: 1420,
    patchedSourceFilesVerified: 1420,
    sourceFilesAfterBuildVerified: 1420,
    cargoVersion: 'cargo 1.95.0 (fixture)',
    rustcVersionVerbose: 'rustc 1.95.0 (fixture)',
    binarySha256: binaryHash,
    binaryCodeSha256: binaryHash,
  };
  writeJson('build-receipt.json', receipt);
  manifest = {
    platform: 'win32',
    arch: 'x64',
    sourceType: 'studio-default-source',
    hostPolicy: policy,
    binaryCodeSha256: binaryHash,
  };
  refreshManifest();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('default host launch provenance', () => {
  it('accepts the declared build and complete managed resources', () => {
    expect(verifyDefaultHostBundle(directory, 'win32-x64').sourceType).toBe('studio-default-source');
  });
  it('rejects replacement code even when the mutable bundle inventory is refreshed', () => {
    fs.writeFileSync(path.join(directory, 'aioncore.exe'), 'replacement code');
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
    receipt.cargoVersion = 'cargo 1.94.0 (fixture)';
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

describe('Windows default source build paths', () => {
  it('keeps the observed aws-lc MSVC output path below MAX_PATH', () => {
    const { defaultHostCacheKey } = require('../../../scripts/studio-preview/host-recovery/prepareDefaultHost.cjs');
    const policyHash = 'fc225fb6369c8dca82942671aa63c8508289143b8f49e32664ceaad54411dd46';
    const recipeHash = '1c0075664430f093' + '0'.repeat(48);
    const root = String.raw`D:\a\aelix-studio\aelix-studio\.local\default-host`;
    const suffix =
      'cargo-target/x86_64-pc-windows-msvc/release/build/aws-lc-sys-c53fc92379a36417/out/out-stdalign_check/4ff06014f56aa32a-stdalign_check.o';
    const full = policyHash + '-' + recipeHash.slice(0, 16) + '-win32-x64';
    const key = defaultHostCacheKey(policyHash, recipeHash, 'win32-x64');
    expect(path.win32.join(root, full, suffix).length).toBeGreaterThan(260);
    expect(path.win32.join(root, key, suffix).length).toBeLessThan(240);
  });
});
