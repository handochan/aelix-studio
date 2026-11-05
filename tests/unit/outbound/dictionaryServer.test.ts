import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDictionaryServer } from '@/process/resources/dictionaryServer';

const roots: string[] = [];
async function requestHosts(url: string, hosts: string[], protocol = 'HTTP/1.1'): Promise<number> {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('Dictionary response timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.on('end', () => {
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(response);
      if (status) resolve(Number(status[1]));
      else reject(new Error('Dictionary response had no HTTP status'));
    });
    socket.on('connect', () =>
      socket.write(
        `GET /en-us-10-1.bdic ${protocol}\r\n${hosts.map((host) => `Host: ${host}\r\n`).join('')}Connection: close\r\n\r\n`
      )
    );
  });
}
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
  it.each(['rebind.invalid', '127.0.0.1.rebind.invalid', 'localhost', '127.0.0.2', '[::1]', '2130706433'])(
    'rejects a DNS rebinding or alternate Host authority %s',
    async (host) => {
      const unavailable = vi.fn();
      const { server, url } = await createDictionaryServer(await fixture(), unavailable);
      try {
        expect(await requestHosts(url, [`${host}:${new URL(url).port}`])).toBe(403);
        expect(unavailable).not.toHaveBeenCalled();
        expect(await requestHosts(url, [new URL(url).host])).toBe(200);
      } finally {
        server.close();
      }
    }
  );
  it('rejects a missing or incorrect bound port', async () => {
    const { server, url } = await createDictionaryServer(await fixture());
    try {
      expect(await requestHosts(url, ['127.0.0.1'])).toBe(403);
      const wrong = Number(new URL(url).port) === 1 ? 2 : 1;
      expect(await requestHosts(url, [`127.0.0.1:${wrong}`])).toBe(403);
      expect(await requestHosts(url, [], 'HTTP/1.0')).toBe(403);
    } finally {
      server.close();
    }
  });
  it('rejects duplicate Host fields even when one is the correct authority', async () => {
    const { server, url } = await createDictionaryServer(await fixture());
    try {
      const host = new URL(url).host;
      expect([400, 403]).toContain(await requestHosts(url, [host, 'rebind.invalid']));
      expect([400, 403]).toContain(await requestHosts(url, [host, host]));
    } finally {
      server.close();
    }
  });
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
