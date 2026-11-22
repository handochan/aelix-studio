import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const renderer = resolve('packages/desktop/src/renderer/services/runtime/RunningInput');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type BrowserFixture = {
  id: string;
  source: string;
  message: string;
  host: string;
  auth: string;
  env: Record<string, string>;
};

/** Use Chromium's canvas and XHR with the production worker, renderer client and protected Host API. */
export async function probeDerivative(fixture: BrowserFixture) {
  const entries = [
    ['/running-input.js', 'index.ts'],
    ['/image.worker.ts', 'Images/image.worker.ts'],
    ['/identity.js', 'transport.ts'],
  ];
  const assets = new Map(
    await Promise.all(
      entries.map(async ([url, entry]) => {
        const result = await Bun.build({
          entrypoints: [join(renderer, entry)],
          target: 'browser',
          format: 'esm',
          define: { 'process.env.AIONUI_MULTI_INSTANCE': '"0"' },
          write: false,
        });
        assert.ok(result.success, 'Browser fixture build failed');
        return [url, result.outputs[0]] as const;
      })
    )
  );
  const uploads: string[] = [];
  const grants: {
    key: string;
    refs: { kind: string; path: string }[];
    descriptor: { id: string; sha256: string; byteLength: number };
  }[] = [];
  const diagnostics: string[] = [];
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      const asset = assets.get(pathname);
      if (asset) return new Response(asset, { headers: { 'content-type': 'text/javascript' } });
      if (pathname === '/')
        return new Response('<title>Studio image fixture</title>', { headers: { 'content-type': 'text/html' } });
      if (!pathname.startsWith('/api/')) return new Response(null, { status: 404 });

      const headers = new Headers({ 'x-aionui-studio-auth': fixture.auth });
      const contentType = request.headers.get('content-type');
      if (contentType) headers.set('content-type', contentType);
      const grantRequest = pathname.endsWith('/byte-grants') ? await request.clone().json() : undefined;
      const reply = await fetch(fixture.host + pathname + search, {
        headers,
        method: request.method,
        body: request.body,
        redirect: 'manual',
      });
      if (reply.ok && pathname === '/api/fs/upload') uploads.push((await reply.clone().json()).data);
      if (reply.ok && grantRequest) {
        grants.push({
          key: grantRequest.prepareId,
          refs: grantRequest.refs,
          descriptor: (await reply.clone().json()).data.grants[0],
        });
      }
      return reply;
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ env: fixture.env });
    const page = await browser.newPage();
    page.on('console', (event) => diagnostics.push(event.text()));
    page.on('pageerror', (error) => diagnostics.push(error.message));
    await page.goto(`http://127.0.0.1:${proxy.port}`);
    const result = await page.evaluate(
      async ({ id, source, message }) => {
        const asset = '/running-input.js';
        const identity = '/identity.js';
        const { createRunningInputClient } = (await import(
          asset
        )) as typeof import('@renderer/services/runtime/RunningInput');
        const { createRequestId } = (await import(
          identity
        )) as typeof import('@renderer/services/runtime/RunningInput/transport');
        const requestId = createRequestId();
        const client = createRunningInputClient(id, { enablePixels: true });
        try {
          await client.refresh();
          const { channel } = client.getSnapshot();
          if (channel.status !== 'ready' || !channel.turn.active) return { status: 'no-active-turn' };
          const sent = await client.submitImages({
            bindingId: channel.bindingId,
            turnId: channel.turn.turnId,
            mode: 'steer',
            requestId,
            message,
            sources: [{ ref: { kind: 'local', path: source } }],
            signal: new AbortController().signal,
            isCurrent: () => true,
          });
          if (sent.status !== 'sent' || sent.receipt.status !== 'queued') {
            const submission = client.getSnapshot().imageSubmission;
            return { status: submission?.status === 'blocked' ? submission.reason : sent.status };
          }
          const image = sent.receipt.pixels?.images[0];
          return {
            status: 'queued',
            requestId,
            image,
            hasPreview: !!image && !!client.getImagePreview(requestId, image.sent.sha256),
          };
        } finally {
          client.dispose();
        }
      },
      { id: fixture.id, source: fixture.source, message: fixture.message }
    );
    assert.equal(result.status, 'queued');
    assert.ok(result.image?.downscaled && result.hasPreview, 'No browser derivative or thumbnail was produced');
    assert.ok(uploads.length === 1 && grants.length === 1, 'Expected one derivative upload and byte grant');
    assert.ok(grants[0].key === result.requestId, 'Grant key differs from the original click');
    const [stored] = uploads;
    assert.ok(
      grants[0].refs.length === 1 && grants[0].refs[0].kind === 'upload' && grants[0].refs[0].path === stored,
      'Grant did not reference the uploaded derivative'
    );
    const bytes = await readFile(stored);
    const digest = sha256(bytes);
    assert.ok(
      digest === result.image.sent.sha256 && digest === grants[0].descriptor.sha256,
      'Derivative digest mismatch'
    );
    assert.ok(
      bytes.length === result.image.sent.bytes && bytes.length === grants[0].descriptor.byteLength,
      'Derivative byte count mismatch'
    );
    return {
      digest,
      diagnostics,
      markers: [stored, digest, grants[0].descriptor.id, bytes.toString('base64').slice(0, 96)],
    };
  } finally {
    await browser?.close();
    proxy.stop(true);
  }
}
