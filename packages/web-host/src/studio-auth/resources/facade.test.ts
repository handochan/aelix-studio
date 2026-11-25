import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startStaticServer, type StaticServerHandle } from '../../static-server.js';
import { getNativeResourcesService } from './service.js';
import fixture from './studio-7-d16-v1.json';
import { RESOURCE_ERROR_STATUS } from './types.js';

const cases = fixture.filter(({ id }) => id.startsWith('helper-error-'));
const example = fixture.find(({ id }) => id === 'helper-envelope')!;
const replyExample = fixture.find(({ id }) => id === 'helper-skills')!.reply!;

describe('native resources WebUI transport', () => {
  let staticDir: string;
  let web: StaticServerHandle;
  let backend: Server;
  let admissions: { cookie: string | undefined; grant: string | undefined }[];
  const handler = vi.spyOn(getNativeResourcesService(), 'request');

  beforeEach(async () => {
    admissions = [];
    backend = createServer((req, res) => {
      admissions.push({ cookie: req.headers.cookie, grant: req.headers['x-aionui-studio-auth'] as string | undefined });
      if (req.url !== '/api/auth/user' || req.headers.cookie !== 'aionui-session=good') {
        res.writeHead(401).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ success: true, user: { id: 'operator' } }));
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    staticDir = await mkdtemp(path.join(tmpdir(), 'studio-resources-web-'));
    await writeFile(path.join(staticDir, 'index.html'), '');
    web = await startStaticServer({ port: 0, staticDir, backendPort: (backend.address() as AddressInfo).port });
    handler.mockResolvedValue({ ok: true, data: replyExample.data! });
  });

  afterEach(async () => {
    handler.mockReset();
    await web.stop();
    backend.closeAllConnections();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(staticDir, { recursive: true, force: true });
  });

  const request = (headers: Record<string, string> = {}, body = JSON.stringify(example.web!.body)) =>
    fetch(web.localUrl + example.web!.path, {
      method: example.web!.http,
      body,
      headers: { ...example.web!.headers, cookie: 'aelix-studio-session=good', origin: web.localUrl, ...headers },
    });

  it('dispatches the fixture command under the admitted cookie identity', async () => {
    const response = await request();
    expect(response.status).toBe(example.httpResponse!.status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(replyExample);
    expect(handler).toHaveBeenCalledExactlyOnceWith('web:operator', example.web!.body);
  });

  it.each([
    { origin: 'https://other.example' },
    { origin: '' },
    { 'x-studio-resources': '' },
    { 'x-studio-auth': '1', 'x-studio-resources': '' },
    { 'content-type': 'application/jsonx' },
    { 'sec-fetch-site': 'same-site' },
  ])('refuses invalid browser admission headers %j', async (headers) => {
    const response = await request(headers as Record<string, string>);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(cases.find(({ id }) => id === 'helper-error-forbidden')!.reply);
    expect(admissions).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { cookie: '', 'x-aionui-studio-auth': 'synthetic-runtime-grant' },
    { cookie: 'aelix-studio-session=expired' },
    { cookie: 'aionui-session=good' },
  ])('requires a browser login even if a runtime grant is presented %j', async (headers) => {
    const response = await request(headers as Record<string, string>);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(cases.find(({ id }) => id === 'helper-error-unauthenticated')!.reply);
    expect(admissions[0].grant).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('caps the UTF-8 request body before dispatch', async () => {
    const response = await request({}, JSON.stringify('界'.repeat(20001)));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(cases.find(({ id }) => id === 'helper-error-frame_limit')!.reply);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(cases)('maps $id to its fixture HTTP status', ({ reply, httpStatus }) => {
    expect(RESOURCE_ERROR_STATUS[reply!.code as keyof typeof RESOURCE_ERROR_STATUS]).toBe(httpStatus);
  });

  it('forwards an admitted revision conflict as the shared error envelope', async () => {
    const example = cases.find(({ id }) => id === 'helper-error-revision_conflict')!;
    handler.mockResolvedValue({ ok: false, code: 'REVISION_CONFLICT', currentRevision: 'g.tool.2' });
    const response = await request();
    expect(response.status).toBe(example.httpStatus);
    expect(await response.json()).toEqual(example.reply);
  });
});
