/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ANALYTICS_PREVIEW_CHANNELS } from '@/common/utils/analyticsPreview';
import { registerAnalyticsPreviewWindow } from '@process/services/analyticsPreview';

const h = vi.hoisted(() => ({ realpath: vi.fn(), lstat: vi.fn(), projectGet: vi.fn() }));
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof import('node:fs/promises')>()),
  realpath: h.realpath,
  lstat: h.lstat,
}));
vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, protocol: {}, session: {} }));
vi.mock('@/common', () => ({ ipcBridge: { project: { get: { invoke: h.projectGet } } } }));

const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const rendererUrl = 'file:///studio/index.html';
const frame = {};
type Handler = (event: { senderFrame: object }, value: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();

let scratch: string;
let root: string;
let documentPath: string;
const markup = '<h1>Workspace</h1>';

beforeEach(async () => {
  h.realpath.mockReset().mockImplementation((filename: string) => fs.realpath(filename));
  h.lstat.mockReset().mockImplementation((filename: string) => fs.lstat(filename));
  scratch = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'studio-classify-')));
  root = path.join(scratch, 'project');
  documentPath = path.join(root, 'workspace', 'index.html');
  await fs.mkdir(path.dirname(documentPath), { recursive: true });
  await fs.writeFile(path.join(root, 'analytics.json'), '{"schema":"analytics.project/2"}');
  await fs.writeFile(documentPath, markup);
  h.projectGet.mockReset().mockResolvedValue({
    project_id: 'project',
    explorer: { entries: [{ pe_id: 'entry', display_path: root, runtime_status: 'available' }] },
  });

  handlers.clear();
  const contents = {
    getURL: () => rendererUrl,
    mainFrame: frame,
    ipc: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    on: vi.fn(),
    once: vi.fn(),
  };
  registerAnalyticsPreviewWindow(contents as unknown as WebContents, [rendererUrl]);
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

function classify(relativePath: string, extra?: Record<string, unknown>) {
  return handlers.get(ANALYTICS_PREVIEW_CHANNELS.classify)!(
    { senderFrame: frame },
    {
      projectId: 'project',
      file: { kind: 'project', pe_id: 'entry', relative_path: relativePath },
      ...extra,
    }
  );
}

describe('Analytics document classification across missing roots', () => {
  it.each(['realpath', 'lstat'] as const)(
    'refuses ordinary rendering when the root disappears during %s and is restored before classification returns',
    async (operation) => {
      await expect(classify('workspace/index.html')).resolves.toBe('isolated');

      let resolvedDocument = false;
      let restoredRoot = false;
      const interruptRootRead = async <T>(read: () => Promise<T>): Promise<T> => {
        const parked = path.join(scratch, 'parked');
        await fs.rename(root, parked);
        try {
          return await read();
        } finally {
          await fs.rename(parked, root);
          restoredRoot = true;
        }
      };
      h.realpath.mockImplementation(async (filename: string) => {
        if (operation === 'realpath' && filename === root && resolvedDocument && !restoredRoot) {
          return interruptRootRead(() => fs.realpath(filename));
        }
        const canonical = await fs.realpath(filename);
        if (filename === documentPath) resolvedDocument = true;
        return canonical;
      });
      h.lstat.mockImplementation((filename: string) => {
        if (operation === 'lstat' && filename === root && resolvedDocument && !restoredRoot) {
          return interruptRootRead(() => fs.lstat(filename));
        }
        return fs.lstat(filename);
      });

      await expect(classify('workspace/index.html', { documentMissing: true })).rejects.toThrow(
        'Analytics project root is unavailable'
      );
      expect(restoredRoot).toBe(true);
      expect(await fs.readFile(documentPath, 'utf8')).toBe(markup);
      await expect(classify('workspace/index.html')).resolves.toBe('isolated');
    }
  );

  it('still confirms absence below a missing candidate root when the requested document was absent from the start', async () => {
    await expect(classify('workspace/deleted/workspace/index.html')).resolves.toBe('missing');
  });

  it('returns inert source if an observed root is replaced during marker lookup', async () => {
    const parked = path.join(scratch, 'parked');
    let replaced = false;
    h.lstat.mockImplementation(async (filename: string) => {
      if (filename === path.join(root, 'analytics.json') && !replaced) {
        await fs.rename(root, parked);
        await fs.mkdir(root);
        replaced = true;
      }
      return fs.lstat(filename);
    });
    await expect(classify('workspace/index.html')).resolves.toBe('source-only');
    expect(replaced).toBe(true);
    await fs.rmdir(root);
    await fs.rename(parked, root);
    expect(await fs.readFile(documentPath, 'utf8')).toBe(markup);
    await expect(classify('workspace/index.html')).resolves.toBe('isolated');
  });
});
