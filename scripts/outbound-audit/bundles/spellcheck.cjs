/** Prepare pinned build-time inputs. This module is never shipped as a downloader. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yauzl = require('yauzl');
const manifest = require('./spellcheck.json');
const notices = require('./spellcheckNotices.json');
const root = path.resolve(__dirname, '../../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function verifiedInput(file, item) {
  let bytes;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!bytes) {
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Spellcheck asset download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    // Gitiles returns source text as base64, including original license notices.
    if (item.url.endsWith('?format=TEXT')) bytes = Buffer.from(bytes.toString().trim(), 'base64');
    if (sha(bytes) !== item.sha256) throw new Error('Spellcheck input checksum mismatch');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  if (bytes.length !== item.bytes || sha(bytes) !== item.sha256)
    throw new Error('Spellcheck cached input checksum mismatch');
  return bytes;
}

async function prepare() {
  if (require('electron/package.json').version !== manifest.electronVersion)
    throw new Error('Update the pinned spellcheck manifest for this Electron version');
  const cache = path.join(root, '.local/offline-inputs/spellcheck');
  const output = path.join(root, '.local/offline-spellcheck');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const archive = await verifiedInput(path.join(cache, 'dictionaries.zip'), manifest.archive);
  const assets = {};
  const store = async (name, bytes, expected) => {
    if (sha(bytes) !== expected.sha256 || bytes.length !== expected.bytes)
      throw new Error('Spellcheck member checksum mismatch');
    const id = sha(Buffer.from(name));
    const relative = path.posix.join(
      'data',
      String(parseInt(id.slice(0, 2), 16) % 8),
      String(parseInt(id.slice(2, 4), 16) % 8),
      name
    );
    const file = path.join(output, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    assets[name.toLowerCase()] = { path: relative, sha256: expected.sha256, bytes: bytes.length };
  };
  await new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const expected = new Map(manifest.files.map((item) => [item.name, item]));
      zip.on('error', reject);
      zip.on('end', () => (expected.size ? reject(new Error('Missing pinned dictionary members')) : resolve()));
      zip.on('entry', (entry) => {
        const item = expected.get(entry.fileName);
        if (!item || path.basename(entry.fileName) !== entry.fileName) {
          zip.close();
          reject(new Error('Unexpected dictionary member'));
          return;
        }
        expected.delete(entry.fileName);
        zip.openReadStream(entry, (error, stream) => {
          if (error) return reject(error);
          const parts = [];
          stream.on('data', (chunk) => parts.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => store(entry.fileName, Buffer.concat(parts), item).then(() => zip.readEntry(), reject));
        });
      });
      zip.readEntry();
    });
  });
  // Retain per-language licensing/provenance notices, not only the aggregate license.
  for (const item of manifest.notices) await store(item.name, Buffer.from(notices[item.name], 'base64'), item);
  const index = {
    schema: manifest.schema,
    electronVersion: manifest.electronVersion,
    archiveSha256: manifest.archive.sha256,
    sourceUrl: manifest.sourceUrl,
    license: manifest.license,
    assets,
  };
  await fs.writeFile(path.join(output, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(
    `Prepared ${Object.keys(assets).filter((name) => name.endsWith('.bdic')).length} pinned dictionaries and ${manifest.notices.length} source/license notices`
  );
}
module.exports = { prepare };
if (require.main === module)
  prepare().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
