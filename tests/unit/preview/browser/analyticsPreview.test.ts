/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, rm, symlink, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyticsPreviewScope } from '@/common/utils/analyticsPreview';
import {
  locateAnalyticsDocument,
  MAX_ANALYTICS_PREVIEW_BYTES,
  scanPreviewJournal,
} from '@process/services/analyticsPreview/files';
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
let completionLine: string;
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
  const root = (await locateAnalyticsDocument(path.join(rootDirectory, 'workspace/index.html')))!.root;
  const saved = manifest({ 'index.html': '<h1>Monthly</h1>', 'script.js': 'void 0', 'link/script.js': 'void 0' });
  await write([...revision.slice(0, -1), 'manifest.json'], saved);
  completionLine =
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
    }) + '\n';
  await write(['journal.jsonl'], completionLine);
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

  it.each([
    {
      name: 'ID on another kind before the completion',
      row: { schema: 'analytics.event/2', kind: 'note', id: 'e1', seq: 2 },
      before: true,
    },
    {
      name: 'sequence on an unsupported row after the completion',
      row: { schema: 'analytics.event/9', kind: 'future', id: 'other', seq: 1 },
      before: false,
    },
  ])('rejects a conflicting $name', async ({ row, before }) => {
    const other = JSON.stringify(row) + '\n';
    await write(['journal.jsonl'], before ? other + completionLine : completionLine + other);
    expect(await savedRevisionFiles(grants.get(reportHost)!.root, revision)).toBeUndefined();
  });

  it('rejects a truncated journal even when its completion was readable earlier', async () => {
    await appendFile(path.join(rootDirectory, 'journal.jsonl'), '{"schema":"analytics.event/2","id":"e2"');
    expect(await savedRevisionFiles(grants.get(reportHost)!.root, revision)).toBeUndefined();
  });

  it('requires an integer completion sequence in the stored JSON', async () => {
    await write(['journal.jsonl'], completionLine.replace('"seq":1', '"seq":1.0'));
    expect(await savedRevisionFiles(grants.get(reportHost)!.root, revision)).toBeUndefined();
  });

  it('does not count another record with a decimal sequence as an integer collision', async () => {
    await appendFile(path.join(rootDirectory, 'journal.jsonl'), '{"schema":"future","id":"decimal","seq":1.0}\n');
    expect((await savedRevisionFiles(grants.get(reportHost)!.root, revision))?.has('index.html')).toBe(true);
  });

  it('accepts a large accumulated journal and detects a conflicting row beyond the asset ceiling', async () => {
    const tail =
      Array.from({ length: 2100 }, (_, index) =>
        JSON.stringify({
          schema: 'analytics.event/2',
          kind: 'note',
          id: `e${index + 2}`,
          seq: index + 2,
          text: '가'.repeat(2750),
        })
      ).join('\n') + '\n';
    expect(Buffer.byteLength(tail)).toBeGreaterThan(MAX_ANALYTICS_PREVIEW_BYTES);
    const journal = await write(['journal.jsonl'], completionLine + tail);
    const root = grants.get(reportHost)!.root;
    const files = await savedRevisionFiles(root, revision);
    expect(files?.has('index.html')).toBe(true);
    await appendFile(journal, '{"schema":"future","id":"late","seq":1}\n');
    expect(await savedRevisionFiles(root, revision)).toBeUndefined();
  });

  it('refuses a journal snapshot changed between scans', async () => {
    const root = grants.get(reportHost)!.root;
    const result = await scanPreviewJournal(root, async (lines) => {
      for await (const line of lines()) expect(line).toBe(completionLine.trim());
      await appendFile(path.join(rootDirectory, 'journal.jsonl'), '{"id":"e2","seq":2}\n');
      for await (const line of lines()) expect(line).toBe(completionLine.trim());
      return true;
    });
    expect(result).toBe(404);
  });

  it('bounds the number of admitted revision verifications', async () => {
    const root = grants.get(reportHost)!.root;
    const attempts = Array.from({ length: 35 }, () => savedRevisionFiles(root, revision));
    expect(await attempts[34]).toBeUndefined();
    expect((await Promise.all(attempts)).filter(Boolean)).toHaveLength(34);
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

  it.each([
    ['workspace', 'reports', 'quarterly', 'site', 'index.html'],
    ['workspace', 'reports', 'quarterly', 'site', 'logo.svg'],
    ['artifacts', 'reports', 'quarterly', '.staging', 'site', 'index.html'],
  ])('leaves ordinary documents to the existing viewer under %j', async (...parts) => {
    const filename = path.join(scratch, 'plain', ...parts);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, 'fixture');
    expect(await locateAnalyticsDocument(filename)).toBeUndefined();
  });

  it('requires the marker for an Analytics document even with an attached subfolder', async () => {
    const filename = await write([...revision, 'index.html'], '<h1>Monthly</h1>');
    expect((await locateAnalyticsDocument(filename))?.scope.kind).toBe('report');
    await rm(path.join(rootDirectory, 'analytics.json'));
    await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Analytics project marker is unavailable');
    await write(['analytics.json'], '{"schema":"ordinary.project/1"}');
    await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Invalid Analytics project marker');
  });

  it('refuses staged Report content when only the prepared manifest identifies the project', async () => {
    await rm(path.join(rootDirectory, 'analytics.json'));
    await rm(path.join(rootDirectory, 'journal.jsonl'));
    const stage = ['artifacts', 'reports', 'monthly', '.staging', 'revision-a'];
    await write([...stage, 'manifest.json'], manifest({ 'index.html': '<h1>Prepared</h1>' }));
    const filename = await write([...stage, 'content', 'index.html'], '<h1>Prepared</h1>');
    await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Analytics project marker is unavailable');
  });

  it('refuses staged content in a mixed journal before its manifest is written', async () => {
    await rm(path.join(rootDirectory, 'analytics.json'));
    const legacy = '{"schema":"lab.event/1","id":"e1","seq":1,"kind":"project","refs":{}}';
    const current = '{"schema":"analytics.event/2","id":"e2","seq":2,"kind":"context","refs":[]}';
    await write(['journal.jsonl'], [legacy, current, ''].join('\n'));
    const filename = await write(
      ['artifacts', 'reports', 'monthly', '.staging', 'revision-a', 'content', 'index.html'],
      '<h1>Prepared</h1>'
    );
    await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Analytics project marker is unavailable');
  });

  it('does not let an unreadable journal row or a nested marker turn a staged Report into a Workspace', async () => {
    await rm(path.join(rootDirectory, 'analytics.json'));
    await writeFile(
      path.join(rootDirectory, 'journal.jsonl'),
      Buffer.concat([
        Buffer.from([0xff, 10]),
        Buffer.from('a'.repeat(70 * 1024) + '\n'),
        Buffer.from(['{"schema":', '{"schema":"lab.event/1","id":"e1","seq":1,"kind":"project"}', ''].join('\n')),
        Buffer.from(completionLine),
      ])
    );
    const content = ['artifacts', 'reports', 'monthly', '.staging', 'revision-a', 'content'];
    await write([...content, 'analytics.json'], '{"schema":"analytics.project/2"}');
    const filename = await write([...content, 'workspace', 'index.html'], '<h1>Prepared</h1>');
    await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Analytics project marker is unavailable');
  });

  it('does not grant a completed revision when another row contains invalid UTF-8', async () => {
    await appendFile(
      path.join(rootDirectory, 'journal.jsonl'),
      Buffer.concat([
        Buffer.from('{"schema":"unrelated","id":"e2","seq":2,"text":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ])
    );
    expect(await savedRevisionFiles(grants.get(reportHost)!.root, revision)).toBeUndefined();
  });

  it('keeps known journal evidence when an append invalidates the scanned snapshot', async () => {
    await rm(path.join(rootDirectory, 'analytics.json'));
    const journal = await write(['journal.jsonl'], '{"schema":"lab.event/1","id":"e1","seq":1,"kind":"project"}\n');
    const filename = await write(
      ['artifacts', 'reports', 'monthly', '.staging', 'revision-a', 'content', 'index.html'],
      '<h1>Prepared</h1>'
    );
    const decode = TextDecoder.prototype.decode;
    let appended = false;
    const spy = vi.spyOn(TextDecoder.prototype, 'decode').mockImplementation(function (
      this: TextDecoder,
      ...args: Parameters<TextDecoder['decode']>
    ) {
      const line = decode.apply(this, args);
      if (!appended && line.includes('"lab.event/1"')) {
        appendFileSync(journal, '{"schema":"analytics.event/2","id":"e2","seq":2,"kind":"context"}\n');
        appended = true;
      }
      return line;
    });
    try {
      await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Analytics project marker is unavailable');
      expect(appended).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('finds a valid nested Workspace despite an unrelated same-named ancestor configuration', async () => {
    await writeFile(path.join(scratch, 'analytics.json'), '{"schema":"ordinary.project/1","enabled":true}');
    const nested = path.join(scratch, 'workspace', 'demo');
    const filename = path.join(nested, 'workspace', 'index.html');
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(path.join(nested, 'analytics.json'), '{"schema":"analytics.project/2"}');
    await writeFile(filename, '<h1>Workspace</h1>');
    const result = await locateAnalyticsDocument(filename);
    expect(result?.root.directory).toContain(path.join('workspace', 'demo'));
    expect(result?.parts).toEqual(['workspace', 'index.html']);
  });

  it('falls back for ordinary HTML and SVG without decoding the tail of a large ancestor journal', async () => {
    const dir = path.join(scratch, 'workspace', 'reports', 'quarterly', 'site');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(scratch, 'journal.jsonl'),
      ('{"schema":"other.event/1","text":"' + 'a'.repeat(1024) + '"}\n').repeat(512) +
        '{"schema":"lab.event/1","id":"tail-evidence","seq":1}\n'
    );
    for (const name of ['index.html', 'logo.svg']) {
      const filename = path.join(dir, name);
      await writeFile(filename, 'ordinary fixture');
      expect(await locateAnalyticsDocument(filename)).toBeUndefined();
    }
  });

  it.each([
    ['artifacts', 'reports', 'monthly', '.staging', 'revision-a', 'content', 'index.html'],
    ['artifacts', 'reports', 'monthly', 'revision-a', 'content', 'index.html'],
    ['workspace', 'reports', 'monthly-stem', 'revision-a', 'files', 'attachment.html'],
    ['workspace', 'reports', 'monthly-stem', 'revision-a', 'preview', 'report.html'],
  ])('refuses an unresolved Report content path under %j', async (...parts) => {
    const directory = await mkdtemp(path.join(scratch, 'unresolved-'));
    const filename = path.join(directory, ...parts);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, '<h1>Report</h1>');
    await writeFile(
      path.join(directory, 'journal.jsonl'),
      ('{"schema":"other.event/1","text":"' + 'a'.repeat(1024) + '"}\n').repeat(512)
    );
    await expect(locateAnalyticsDocument(filename)).rejects.toThrow('Analytics project marker is unavailable');
  });

  it('admits two probes without queuing ordinary previews or allowing prepared Reports to fall back', async () => {
    const plain = await Promise.all(
      ['left', 'right', 'other'].map(async (name) => {
        const dir = path.join(scratch, name, 'workspace');
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'index.html'), '<h1>Ordinary</h1>');
        await writeFile(path.join(path.dirname(dir), 'journal.jsonl'), '{"schema":"unrelated"}\n');
        return path.join(dir, 'index.html');
      })
    );
    const staged = ['artifacts', 'reports', 'monthly', '.staging', 'revision-a'];
    const prepared = await write([...staged, 'content', 'index.html'], '<h1>Prepared</h1>');
    const confirmed = await write([...staged, 'content', 'confirmed.html'], '<h1>Prepared</h1>');
    await rm(path.join(rootDirectory, 'analytics.json'));
    const journal = await write(['journal.jsonl'], '{"schema":"unrelated"}\n');

    type Read = (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) => Promise<unknown>;
    const handle = await open(journal, 'r');
    const prototype = Object.getPrototypeOf(handle) as { read: Read };
    await handle.close();
    const read = prototype.read;
    let entered = 0;
    let release!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(prototype, 'read').mockImplementation(async function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number
    ) {
      if (buffer.length === 64 * 1024 && ++entered <= 2) await pause;
      return read.call(this, buffer, offset, length, position);
    });
    const firstTwo = Promise.all(plain.slice(0, 2).map(locateAnalyticsDocument));
    let finished = false;
    const probeRest = async () => {
      expect(await locateAnalyticsDocument(plain[2])).toBeUndefined();
      await expect(locateAnalyticsDocument(prepared)).rejects.toThrow('Analytics project marker is unavailable');
      await write([...staged, 'manifest.json'], manifest({ 'confirmed.html': '<h1>Prepared</h1>' }));
      await expect(locateAnalyticsDocument(confirmed)).rejects.toThrow('Analytics project marker is unavailable');
      finished = true;
    };
    let rest: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(2));
      rest = probeRest();
      void rest.catch(() => {});
      await vi.waitFor(() => expect(finished).toBe(true));
      expect(entered).toBe(2);
    } finally {
      release();
      await Promise.allSettled([firstTwo, rest]);
      spy.mockRestore();
    }
  });
});
