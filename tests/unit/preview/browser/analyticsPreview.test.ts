/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyticsPreviewScope } from '@/common/utils/analyticsPreview';
import { MAX_ANALYTICS_PREVIEW_BYTES, resolvePreviewRoot } from '@process/services/analyticsPreview/files';
import { previewUrl, servePreview, type PreviewGrant } from '@process/services/analyticsPreview/protocol';
import { savedRevisionFiles } from '@process/services/analyticsPreview/revision';

const workspace = ['workspace'];
const revision = ['artifacts', 'reports', 'monthly', 'revision-a', 'content'];
const otherRevision = ['artifacts', 'reports', 'monthly', 'revision-b', 'content'];
const [workspaceHost, reportHost] = ['a'.repeat(32), 'b'.repeat(32)];

let scratch: string;
let rootDirectory: string;
let grants: Map<string, PreviewGrant>;
let authorize: () => Promise<boolean>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function write(parts: string[], data: string) {
  const filename = path.join(rootDirectory, ...parts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, data);
  return filename;
}

function manifest(files: Record<string, string>) {
  return JSON.stringify({
    schema: 'analytics.report_revision/1',
    report_id: revision[2],
    revision_id: revision[3],
    request_id: 'request-1',
    previous_revision: null,
    entry: 'index.html',
    files: Object.entries(files).map(([file, value]) => ({
      path: file,
      bytes: Buffer.byteLength(value),
      sha256: sha(value),
    })),
  });
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'analytics-preview-'));
  rootDirectory = path.join(scratch, '분석 project');
  await write(['analytics.json'], '{"schema":"analytics.project/2"}');
  const workspaceScope = analyticsPreviewScope([...workspace, 'index.html'].join('/'))!;
  const reportScope = analyticsPreviewScope([...revision, 'index.html'].join('/'))!;
  const root = (await resolvePreviewRoot(rootDirectory, workspaceScope))!;
  const saved = manifest({ 'index.html': '<h1>Monthly</h1>', 'script.js': 'void 0', 'link/script.js': 'void 0' });
  await write([...revision.slice(0, -1), 'manifest.json'], saved);
  await write(
    ['journal.jsonl'],
    JSON.stringify({
      schema: 'analytics.event/2',
      kind: 'report_revision',
      id: 'e1',
      seq: 1,
      request_id: 'request-1',
      details: { previous_revision: null },
      refs: [
        {
          type: 'report_revision',
          report_id: revision[2],
          revision_id: revision[3],
          relation: 'about',
          basis: 'observed',
          version_binding: 'author',
          digest: { sha256: sha(saved) },
        },
      ],
    }) + '\n'
  );
  authorize = async () => true;
  const authority = { permits: () => true, authorized: () => authorize() };
  grants = new Map([
    [workspaceHost, { root, scope: workspaceScope, ...authority }],
    [reportHost, { root, scope: reportScope, files: await savedRevisionFiles(root, revision), ...authority }],
  ]);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const get = (url: string, method = 'GET') => servePreview({ url, method }, (host) => grants.get(host));

describe('Analytics preview resource routing', () => {
  it('serves an encoded nested page and relative assets as original bytes with a restrictive CSP', async () => {
    const entry = previewUrl(workspaceHost, [...workspace, '목록', '상세 페이지.html']);
    const css = 'body { font-family: sans-serif; }';
    await write([...workspace, '목록', '상세 페이지.html'], '<link rel="stylesheet" href="../assets/basic.css">');
    await write([...workspace, 'assets', 'basic.css'], css);
    const page = await get(entry);
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await (await get(new URL('../assets/basic.css?v=1', entry).href)).text()).toBe(css);
  });

  it('allows a Workspace chart image and denies a raw file outside the preview layout', async () => {
    const parts = ['runs', 'run-1', 'visualizations', 'chart.svg'];
    await write(parts, '<svg/>');
    await write(['private.json'], '{}');
    expect((await get(previewUrl(workspaceHost, parts))).headers.get('Content-Type')).toBe('image/svg+xml');
    expect((await get(previewUrl(workspaceHost, ['private.json']))).status).toBe(404);
  });

  it('serves Report assets only from the selected revision', async () => {
    for (const dir of [revision, otherRevision, workspace]) {
      await write([...dir, 'script.js'], 'void 0');
    }
    expect((await get(previewUrl(reportHost, [...revision, 'script.js']))).status).toBe(200);
    expect((await get(previewUrl(reportHost, [...otherRevision, 'script.js']))).status).toBe(404);
    expect((await get(previewUrl(reportHost, [...workspace, 'script.js']))).status).toBe(404);
    expect((await get(previewUrl(workspaceHost, [...revision, 'script.js']))).status).toBe(404);
  });

  it('rejects added and changed bytes and refuses a rewritten manifest', async () => {
    await write([...revision, 'script.js'], 'void 1');
    await write([...revision, 'added.js'], 'void 0');
    expect((await get(previewUrl(reportHost, [...revision, 'script.js']))).status).toBe(409);
    expect((await get(previewUrl(reportHost, [...revision, 'added.js']))).status).toBe(404);

    const replacement = manifest({ 'index.html': '<h1>Monthly</h1>', 'script.js': 'void 1', 'added.js': 'void 0' });
    await write([...revision.slice(0, -1), 'manifest.json'], replacement);
    expect(await savedRevisionFiles(grants.get(reportHost)!.root, revision)).toBeUndefined();
  });

  it('keeps copies out of the Workspace origin and renders the derived body without scripts', async () => {
    const view = [...workspace, 'reports', 'monthly-stem', 'revision-a'];
    const copy = [...view, 'files', 'attachment.html'];
    const body = [...view, 'preview', 'report.html'];
    await write(copy, '<script>void 0</script>');
    await write(body, '<h1>Monthly</h1>');
    expect((await get(previewUrl(workspaceHost, copy))).status).toBe(404);
    expect((await get(previewUrl(workspaceHost, body))).headers.get('Content-Security-Policy')).toContain(
      "script-src 'none'"
    );
  });

  it('rechecks attachment authority before returning bytes read from an open grant', async () => {
    const parts = [...workspace, 'index.html'];
    await write(parts, '<h1>Workspace</h1>');
    let checks = 0;
    authorize = async () => ++checks === 1;
    expect((await get(previewUrl(workspaceHost, parts))).status).toBe(403);
    expect(checks).toBe(2);
  });

  it('denies out-of-scope paths, non-preview origins and writes', async () => {
    await write(['secret.js'], 'void 0');
    expect((await get(`studio-analytics://${workspaceHost}/workspace/%2e%2e/secret.js`)).status).toBe(404);
    expect((await get(`studio-analytics://${workspaceHost}/workspace/nested%2fsecret.js`)).status).toBe(403);
    expect((await get(`studio-analytics://${workspaceHost}/workspace/a%5csecret.js`)).status).toBe(403);
    expect((await get('http://127.0.0.1/api/fs/content')).status).toBe(403);
    expect((await get(previewUrl(workspaceHost, [...workspace, 'index.html']), 'POST')).status).toBe(403);
  });

  it('does not follow directory links across a Report boundary', async () => {
    const other = await write([...otherRevision, 'script.js'], 'void 0');
    const current = await write([...revision, 'index.html'], '<h1>Monthly</h1>');
    await symlink(path.dirname(other), path.join(path.dirname(current), 'link'), 'junction');
    expect((await get(previewUrl(reportHost, [...revision, 'link', 'script.js']))).status).toBe(404);
  });

  it('enforces a resource ceiling independently of the 1 MiB editor default', async () => {
    const parts = [...workspace, 'assets', 'large.js'];
    const filename = await write(parts, '');
    const url = previewUrl(workspaceHost, parts);
    await truncate(filename, 1024 * 1024 + 1);
    expect((await get(url)).status).toBe(200);
    await truncate(filename, MAX_ANALYTICS_PREVIEW_BYTES + 1);
    expect((await get(url)).status).toBe(413);
  });

  it('discards a file read when its origin is revoked during the read', async () => {
    const parts = [...workspace, 'index.html'];
    await write(parts, '<h1>Workspace</h1>');
    const pending = get(previewUrl(workspaceHost, parts));
    grants.delete(workspaceHost);
    expect((await pending).status).toBe(403);
  });

  it('requires the project marker independently of the attached folder location', async () => {
    const candidate = path.basename(rootDirectory) + '/workspace/index.html';
    const scope = analyticsPreviewScope(candidate)!;
    expect((await resolvePreviewRoot(scratch, scope))?.directory).toContain('분석 project');
    await rm(path.join(rootDirectory, 'analytics.json'));
    expect(await resolvePreviewRoot(scratch, scope)).toBeUndefined();
    const reportScope = analyticsPreviewScope([...revision, 'index.html'].join('/'))!;
    await expect(resolvePreviewRoot(rootDirectory, reportScope)).rejects.toThrow(
      'Analytics project marker is unavailable'
    );
    await write(['analytics.json'], '{"schema":"ordinary.project/1"}');
    await expect(resolvePreviewRoot(scratch, scope)).rejects.toThrow('Invalid Analytics project marker');
  });
});
