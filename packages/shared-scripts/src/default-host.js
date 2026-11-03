/** Pinned release-host provenance shared by preparation and launchers. */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const policy = require('../../../scripts/studio-preview/host-release/default.json');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (file) => sha256(fs.readFileSync(file));
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .toSorted()
            .map((key) => [key, item[key]])
        )
      : item
  );

/** Normalize only bounded terminal Mach-O signature metadata, retaining all code bytes. */
function codeIdentity(raw) {
  if (raw.length < 32 || raw.readUInt32LE(0) !== 0xfeedfacf) return sha256(raw);
  const data = Buffer.from(raw);
  const count = data.readUInt32LE(16),
    commandBytes = data.readUInt32LE(20);
  const end = 32 + commandBytes;
  if (end > data.length) throw new Error('Truncated host load commands');
  let offset = 32,
    linkedit = null,
    signature = null;
  for (let index = 0; index < count; index++) {
    if (offset + 8 > end) throw new Error('Truncated host command');
    const command = data.readUInt32LE(offset),
      size = data.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > end) throw new Error('Invalid host command');
    if (
      command === 0x19 &&
      data
        .subarray(offset + 8, offset + 24)
        .toString()
        .split(String.fromCharCode(0))[0] === '__LINKEDIT'
    ) {
      if (linkedit || size < 72) throw new Error('Invalid host LINKEDIT');
      const vmSize = Number(data.readBigUInt64LE(offset + 32));
      const fileOffset = Number(data.readBigUInt64LE(offset + 40));
      const fileSize = Number(data.readBigUInt64LE(offset + 48));
      if (
        ![vmSize, fileOffset, fileSize].every(Number.isSafeInteger) ||
        vmSize < fileSize ||
        fileOffset < end ||
        fileOffset + fileSize !== data.length
      )
        throw new Error('Invalid host LINKEDIT extent');
      linkedit = { offset, fileOffset };
    }
    if (command === 0x1d) {
      if (signature || size !== 16 || index !== count - 1) throw new Error('Invalid host signature command');
      const at = data.readUInt32LE(offset + 8),
        length = data.readUInt32LE(offset + 12);
      if (at % 16 || at + length !== data.length || length < 12) throw new Error('Invalid host signature extent');
      const declared = data.readUInt32BE(at + 4),
        blobs = data.readUInt32BE(at + 8);
      if (
        data.readUInt32BE(at) !== 0xfade0cc0 ||
        declared < 12 ||
        declared > length ||
        blobs < 1 ||
        blobs > Math.floor((declared - 12) / 8)
      )
        throw new Error('Invalid host signature blob');
      for (let entry = 0; entry < blobs; entry++) {
        const blob = data.readUInt32BE(at + 16 + entry * 8);
        if (blob < 12 + blobs * 8 || blob + 8 > declared) throw new Error('Invalid host signature index');
        const blobLength = data.readUInt32BE(at + blob + 4);
        if (blobLength < 8 || blob + blobLength > declared) throw new Error('Invalid host signature length');
      }
      signature = { offset, at };
    }
    offset += size;
  }
  if (!linkedit || offset !== end || (signature && signature.at < linkedit.fileOffset))
    throw new Error('Invalid host link layout');
  let body = data;
  if (signature) {
    body = data.subarray(0, signature.at);
    body.fill(0, signature.offset, signature.offset + 16);
    body.writeUInt32LE(count - 1, 16);
    body.writeUInt32LE(commandBytes - 16, 20);
  }
  const normalized = Buffer.concat([body, Buffer.alloc((16 - (body.length % 16)) % 16)]);
  normalized.writeBigUInt64LE(0n, linkedit.offset + 32);
  normalized.writeBigUInt64LE(BigInt(normalized.length - linkedit.fileOffset), linkedit.offset + 48);
  return sha256(normalized);
}

function inventory(directory, { excludeManifest = true } = {}) {
  const root = fs.realpathSync.native(directory),
    result = {};
  function visit(current) {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name),
        relative = path.relative(root, file).split(path.sep).join('/');
      if (excludeManifest && relative === 'manifest.json') continue;
      const real = fs.realpathSync.native(file);
      if (!real.startsWith(root + path.sep)) throw new Error('Default host resource escapes its bundle');
      if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link)) throw new Error('Default host contains an absolute resource link');
        result[relative] = 'symlink:' + link;
      } else if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result[relative] = codeIdentity(fs.readFileSync(file));
      else throw new Error('Unsupported default host resource entry');
    }
  }
  visit(root);
  return result;
}

/** Verify immutable release provenance and installer-stable code identity before spawning. */
function verifyDefaultHostBundle(directory, target) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const expected = policy.targets[target];
  if (!expected || manifest.sourceType !== 'studio-host-release' || stable(manifest.hostPolicy) !== stable(policy))
    throw new Error('Default host release policy differs from this Studio build');
  if (`${manifest.platform}-${manifest.arch}` !== target) throw new Error('Default host target differs');
  const provenanceFile = path.join(directory, 'release-provenance.json');
  if (digest(provenanceFile) !== policy.provenanceSha256) throw new Error('Default host release provenance changed');
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
  if (
    provenance.schema !== 'aelix-studio-host.release-provenance/1' ||
    provenance.kind !== 'release' ||
    provenance.label !== policy.tag ||
    provenance.repository !== policy.repository ||
    provenance.commit !== policy.commit ||
    provenance.tree !== policy.tree ||
    stable(provenance.targets[target]) !== stable(expected)
  )
    throw new Error('Default host release provenance differs');
  const receiptFile = path.join(directory, 'build-receipt.json');
  if (digest(receiptFile) !== manifest.buildReceiptSha256) throw new Error('Default host build receipt changed');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (
    receipt.schema !== 'aelix-studio-host.build-receipt/1' ||
    receipt.status !== 'built' ||
    receipt.dirty !== false ||
    receipt.repository !== policy.repository ||
    receipt.commit !== policy.commit ||
    receipt.tree !== policy.tree ||
    receipt.label !== policy.tag ||
    receipt.target !== target ||
    receipt.binary !== expected.binary ||
    receipt.archive !== expected.archive ||
    receipt.binarySha256 !== expected.binarySha256 ||
    receipt.binaryCodeSha256 !== expected.binaryCodeSha256 ||
    receipt.rustToolchain !== policy.rustToolchain ||
    receipt.profile !== 'release' ||
    receipt.cargoLockSha256 !== policy.cargoLockSha256 ||
    stable(receipt.upstream) !==
      stable({
        repository: policy.upstream.repository,
        tag: policy.upstream.tag,
        commit: policy.upstream.commit,
      }) ||
    receipt.licenseSha256 !== policy.licenseSha256 ||
    receipt.noticeSha256 !== policy.noticeSha256
  )
    throw new Error('Default host build provenance differs');
  if (target.startsWith('linux-')) {
    const maximum = receipt.maximumGlibcVersionNeeded;
    const compare = (version) =>
      version
        .replace(/^GLIBC_/, '')
        .split('.')
        .reduce((result, part) => result * 1000 + Number(part), 0);
    if (
      typeof maximum !== 'string' ||
      !/^GLIBC_[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(maximum) ||
      compare(maximum) > compare(expected.glibcCeiling) ||
      stable(receipt.buildContainer) !== stable(expected.buildContainer)
    )
      throw new Error('Default host compiler container or GLIBC compatibility differs');
  }
  if (
    digest(path.join(directory, 'LICENSE')) !== policy.licenseSha256 ||
    digest(path.join(directory, 'NOTICE')) !== policy.noticeSha256 ||
    codeIdentity(fs.readFileSync(path.join(directory, expected.binary))) !== expected.binaryCodeSha256
  )
    throw new Error('Default host code or upstream license changed');
  if (stable(inventory(directory)) !== stable(manifest.inventory))
    throw new Error('Default host resource inventory changed');
  if (
    sha256(stable(inventory(path.join(directory, 'managed-resources'), { excludeManifest: false }))) !==
    manifest.managedResourcesSha256
  )
    throw new Error('Default host managed resources differ from the build receipt');
  const resources = require('./verify-bundled-aioncore-resources').verifyBundledAioncoreResources({
    resourcesDir: path.resolve(directory, '../..'),
    bundleDir: directory,
    electronPlatformName: manifest.platform,
    targetArch: manifest.arch,
    verifySource: false,
  });
  if (resources.missing.length || resources.failures.length)
    throw new Error('Default host managed resource contract differs');
  return manifest;
}

module.exports = { policy, digest, codeIdentity, inventory, stable, verifyDefaultHostBundle };
