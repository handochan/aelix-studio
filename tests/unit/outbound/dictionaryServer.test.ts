import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDictionaryServer } from '@/process/resources/dictionaryServer';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(corrupt = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'studio-dictionary-'));
  roots.push(root);
  const bytes = Buffer.from('synthetic dictionary');
  await mkdir(path.join(root, 'data'));
  await writeFile(path.join(root, 'data/en-US-10-1.bdic'), bytes);
  await writeFile(
    path.join(root, 'index.json'),
    JSON.stringify({
      schema: 'aelix.spellcheck-assets/1',
      assets: {
        'en-us-10-1.bdic': {
          path: 'data/en-US-10-1.bdic',
          bytes: bytes.length,
          sha256: createHash('sha256')
            .update(corrupt ? 'other' : bytes)
            .digest('hex'),
        },
      },
    })
  );
  return root;
}
describe('bundled dictionary feed', () => {
  it('serves a case-normalized dictionary only on IPv4 loopback', async () => {
    const { server, url } = await createDictionaryServer(await fixture());
    try {
      expect(new URL(url).hostname).toBe('127.0.0.1');
      expect(await (await fetch(url + 'en-us-10-1.bdic')).text()).toBe('synthetic dictionary');
    } finally {
      server.close();
    }
  });
  it('rejects missing files and traversal without remote fallback', async () => {
    const { server, url } = await createDictionaryServer(await fixture());
    try {
      expect((await fetch(url + 'unknown.bdic')).status).toBe(404);
      expect((await fetch(url + '%2e%2e%2findex.json')).status).toBe(404);
    } finally {
      server.close();
    }
  });
  it('fails closed for corrupted bundled bytes', async () => {
    const { server, url } = await createDictionaryServer(await fixture(true));
    try {
      expect((await fetch(url + 'en-us-10-1.bdic')).status).toBe(500);
    } finally {
      server.close();
    }
  });
  it('rejects an invalid index before starting a server', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'index.json'), '{}');
    await expect(createDictionaryServer(root)).rejects.toThrow('Invalid bundled dictionary index');
  });
});
