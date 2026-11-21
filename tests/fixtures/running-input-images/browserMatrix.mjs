import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const [fixtures, requestedPort = '45105'] = process.argv.slice(2);
assert.ok(fixtures, 'Usage: browserMatrix.mjs FIXTURE_DIR [PORT]');
const assets = path.resolve('out/renderer/assets');
const entry = (await readdir(assets)).find((name) => /^running-input-images-.*\.js$/.test(name));
assert.ok(entry, 'Build the production renderer first');
const acceptance = await readFile(new URL('./acceptance.mjs', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = [...Array.from({ length: 8 }, (_, index) => `exif-${index + 1}.jpg`), 'alpha.png'];
const cases = await Promise.all(
  names.map(async (name) => ({ name, sha256: sha256(await readFile(path.join(fixtures, name))) }))
);
const uploads = new Map();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; worker-src 'self'",
        })
        .end(
          '<title>Studio image worker browser matrix</title><pre></pre><script type="module" src="/matrix.js"></script>'
        );
    } else if (url.pathname === '/matrix.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(`
        import { exerciseImageWorker } from './acceptance.mjs';
        const results = [];
        const cases = ${JSON.stringify(cases)};
        const entry = ${JSON.stringify('/assets/' + entry)};
        const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
        const cornerOrder = [[0,1,2,3],[1,0,3,2],[3,2,1,0],[2,3,0,1],[0,2,1,3],[2,0,3,1],[3,1,2,0],[1,3,0,2]];
        const colors = [[235,20,20],[20,235,20],[20,20,235],[235,235,20]];
        for (const [index, test] of cases.entries()) {
          try {
            const bytes = new Uint8Array(await fetch('/fixtures/' + test.name).then((response) => response.arrayBuffer()));
            const result = await exerciseImageWorker({ entry, conversationId: 'matrix', name: test.name,
              base64: b64(bytes), edgeLimit: 2048, forceJsHash: true });
            const received = await fetch('/matrix-digest?path=' + encodeURIComponent(result.ref.path)).then((response) => response.text());
            if (received !== result.sent.digest.sha256 || test.sha256 !== result.original.digest.sha256) {
              throw new Error('Independent digest mismatch');
            }
            if (index < 8) {
              const expected = index >= 4 ? [64,96] : [96,64];
              if (result.sent.width !== expected[0] || result.sent.height !== expected[1]) throw new Error('Dimensions');
              const matches = result.pixels.every((pixel, corner) =>
                colors[cornerOrder[index][corner]].every((value, channel) => Math.abs(pixel[channel] - value) < 12));
              if (!matches) throw new Error('Corner colors');
              if (atob(result.output).includes('Exif\\0\\0') !== (index === 0)) throw new Error('EXIF/GPS');
            } else if (result.pixels[0][3] !== 0 || result.pixels[1][3] !== 128 ||
                       ![133,99,88].every((value, index) => Math.abs(result.pixels[1][index] - value) <= 6)) {
              throw new Error('sRGB/alpha sample ' + JSON.stringify(result.pixels));
            }
            results.push({ fixture: test.name, result: 'passed' });
          } catch (error) {
            results.push({ fixture: test.name, result: error.message });
          }
        }
        const report = JSON.stringify({ browser: navigator.userAgent, results });
        document.querySelector('pre').textContent = report;
        await fetch('/matrix-report', { method: 'POST', body: report });
      `);
    } else if (url.pathname === '/acceptance.mjs') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(acceptance);
    } else if (/^\/assets\/[\w.-]+\.js$/.test(url.pathname)) {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(await readFile(path.join(assets, path.basename(url.pathname))));
    } else if (url.pathname.startsWith('/fixtures/') && names.includes(path.basename(url.pathname))) {
      response
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(await readFile(path.join(fixtures, path.basename(url.pathname))));
    } else if (url.pathname === '/api/fs/upload' && request.method === 'POST') {
      const data = await new Response(request, {
        headers: { 'content-type': request.headers['content-type'] },
      }).formData();
      const file = data.get('file');
      const id = randomUUID();
      uploads.set(id, { content: Buffer.from(await file.arrayBuffer()), type: file.type });
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ success: true, data: id }));
    } else if (url.pathname === '/api/fs/stream' || url.pathname === '/matrix-digest') {
      const value = uploads.get(url.searchParams.get('path'));
      if (!value) return response.writeHead(404).end();
      if (url.pathname === '/matrix-digest') {
        uploads.delete(url.searchParams.get('path'));
        return response.writeHead(200).end(sha256(value.content));
      }
      response.writeHead(200, { 'content-type': value.type }).end(value.content);
    } else if (url.pathname === '/matrix-report' && request.method === 'POST') {
      const report = await new Response(request).json();
      console.log(JSON.stringify(report));
      response.writeHead(204).end();
    } else {
      response.writeHead(404).end();
    }
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(Number(requestedPort), '127.0.0.1', () => console.log('Browser matrix ready'));
