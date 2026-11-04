/** Serve immutable bundled Hunspell files only on loopback; never fall back to a CDN. */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

type DictionaryIndex = { schema: string; assets: Record<string, { path: string; sha256: string; bytes: number }> };

export async function createDictionaryServer(
  directory: string,
  onUnavailable: () => void = () => {}
): Promise<{ server: Server; url: string }> {
  const root = await realpath(directory);
  const index = JSON.parse(await readFile(path.join(root, 'index.json'), 'utf8')) as DictionaryIndex;
  if (index.schema !== 'aelix.spellcheck-assets/1' || !index.assets || typeof index.assets !== 'object')
    throw new Error('Invalid bundled dictionary index');
  const server = createServer((request, response) => {
    const address = server.address();
    const hosts = request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'host');
    if (
      !address ||
      typeof address === 'string' ||
      hosts.length !== 1 ||
      request.headers.host !== `${address.address}:${address.port}`
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    void (async () => {
      const name = (request.url ?? '').slice(1).toLowerCase();
      const item = /^[a-z0-9-]+\.bdic$/.test(name) ? index.assets[name] : undefined;
      if (request.method !== 'GET' || !item) {
        response.writeHead(404);
        response.end();
        return;
      }
      const file = await realpath(path.resolve(root, item.path));
      if (!file.startsWith(root + path.sep)) throw new Error('Bundled dictionary escapes asset directory');
      const bytes = await readFile(file);
      if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
        throw new Error('Bundled dictionary checksum mismatch');
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(bytes);
    })().catch((error: unknown) => {
      console.error('[spellcheck] Local dictionary unavailable', error);
      onUnavailable();
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Local dictionary server did not bind');
  }
  server.unref();
  return { server, url: `http://127.0.0.1:${address.port}/` };
}
