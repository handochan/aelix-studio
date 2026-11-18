/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { app, protocol, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ipcBridge } from '@/common';
import { isChatFileRef } from '@/common/types/chatFile';
import {
  ANALYTICS_PREVIEW_CHANNELS,
  analyticsPathSegments,
  analyticsPreviewScope,
  type AnalyticsPreviewRequest,
  type AnalyticsPreviewScope,
} from '@/common/utils/analyticsPreview';
import { previewFileType, resolvePreviewRoot } from './files';
import {
  ANALYTICS_PARTITION,
  ANALYTICS_SCHEME,
  parsePreviewUrl,
  previewUrl,
  servePreview,
  type PreviewGrant,
} from './protocol';

const MAX_REPORT_ORIGINS = 32;

type Preview = {
  url: string;
  partition: Electron.Session;
  guest?: WebContents;
  grants: Map<string, PreviewGrant>;
  reportHosts: Map<string, string>;
};

/** Register before app ready so Chromium gives these documents real, distinct origins. */
export function registerAnalyticsPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ANALYTICS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const previews = new Map<string, Preview>();
let previewSession: Promise<Electron.Session> | undefined;

function getGrant(host: string): PreviewGrant | undefined {
  return previews.get(host)?.grants.get(host);
}

async function configureDenyProxy(isolated: Electron.Session): Promise<void> {
  // Backstop Chromium transports that bypass webRequest with an owned listener
  // that accepts no SOCKS requests. Strip the implicit localhost bypass.
  const denyProxy = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolve, reject) => {
      denyProxy.once('error', reject);
      denyProxy.listen(0, '127.0.0.1', resolve);
    });
    const address = denyProxy.address();
    if (!address || typeof address === 'string') throw new Error('Preview proxy did not bind');
    await isolated.setProxy({
      mode: 'fixed_servers',
      proxyRules: `socks5://127.0.0.1:${address.port}`,
      proxyBypassRules: '<-loopback>',
    });
    app.once('will-quit', () => denyProxy.close());
    denyProxy.unref();
  } catch (error) {
    denyProxy.close();
    throw error;
  }
}

async function initializeSession(): Promise<Electron.Session> {
  const isolated = session.fromPartition(ANALYTICS_PARTITION, { cache: false });
  await configureDenyProxy(isolated);
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_guest, _permission, callback) => callback(false));
  isolated.setDevicePermissionHandler(() => false);
  isolated.on('will-download', (event) => event.preventDefault());
  isolated.webRequest.onBeforeRequest((details, done) => {
    const target = parsePreviewUrl(details.url);
    const preview = target && previews.get(target.host);
    const localImage = details.resourceType === 'image' && details.url.startsWith('data:image/');
    done({
      cancel:
        !localImage && (!preview || preview.guest?.id !== details.webContentsId || details.resourceType === 'subFrame'),
    });
  });
  isolated.protocol.handle(ANALYTICS_SCHEME, (request) => servePreview(request, getGrant));
  return isolated;
}

function validateRequest(value: unknown): AnalyticsPreviewRequest | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    value.projectId &&
    'file' in value &&
    isChatFileRef(value.file) &&
    value.file.kind === 'project'
  ) {
    return { projectId: value.projectId, file: value.file };
  }
}

async function resolveEntry(request: AnalyticsPreviewRequest) {
  const scope = analyticsPreviewScope(request.file.relative_path);
  if (!scope) return;
  const project = await ipcBridge.project.get.invoke({ project_id: request.projectId });
  const entry = project?.explorer.entries.find(({ pe_id }) => pe_id === request.file.pe_id);
  if (project?.project_id !== request.projectId || entry?.runtime_status !== 'available') {
    throw new Error('Explorer root unavailable');
  }
  const root = await resolvePreviewRoot(entry.display_path, scope);
  if (!root) return;
  const parts = analyticsPathSegments(request.file.relative_path)?.slice(scope.project.length);
  if (parts && previewFileType(scope, parts)?.startsWith('text/html')) return { root, scope, parts };
}

function addGrant(preview: Preview, grant: PreviewGrant): string {
  const host = randomBytes(16).toString('hex');
  preview.grants.set(host, grant);
  previews.set(host, preview);
  return host;
}

function release(preview: Preview): void {
  for (const host of preview.grants.keys()) {
    previews.delete(host);
    void preview.partition.clearStorageData({ origin: `${ANALYTICS_SCHEME}://${host}` }).catch(() => {});
  }
  preview.grants.clear();
  preview.reportHosts.clear();
}

function navigationTarget(preview: Preview, url: string): string | undefined {
  const current = parsePreviewUrl(preview.guest?.getURL() ?? '');
  const target = parsePreviewUrl(url);
  if (!current || !target || current.host !== target.host) return;
  const grant = preview.grants.get(current.host);
  if (!grant) return;
  if (previewFileType(grant.scope, target.parts)?.startsWith('text/html')) return url;
  if (grant.scope.kind !== 'workspace') return;

  // Workspace links to original Reports using the project's relative layout.
  // Only a navigation can grant a Report origin. Subresource requests never can.
  const scope = analyticsPreviewScope(target.parts.join('/'));
  if (scope?.kind !== 'report' || scope.project.length) return;
  return reportNavigation(preview, grant, scope, target.parts, url);
}

function reportNavigation(
  preview: Preview,
  grant: PreviewGrant,
  scope: Extract<AnalyticsPreviewScope, { kind: 'report' }>,
  parts: string[],
  url: string
): string | undefined {
  const key = scope.revision.join('/');
  let host = preview.reportHosts.get(key);
  if (!host) {
    if (preview.reportHosts.size >= MAX_REPORT_ORIGINS) return;
    host = addGrant(preview, { root: grant.root, scope });
    preview.reportHosts.set(key, host);
  }
  const parsed = new URL(url);
  return previewUrl(host, parts) + parsed.search + parsed.hash;
}

function bindGuest(preview: Preview, guest: WebContents): void {
  preview.guest = guest;
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const load = (url: string): void => {
    void guest.loadURL(url).catch(() => {});
  };
  guest.on('will-frame-navigate', (event) => {
    const target = event.isMainFrame && navigationTarget(preview, event.url);
    if (target === event.url) return;
    event.preventDefault();
    if (target) load(target);
  });
  guest.on('will-redirect', (event) => event.preventDefault());
  guest.setWindowOpenHandler(({ url }) => {
    const target = navigationTarget(preview, url);
    if (target) load(target);
    return { action: 'deny' };
  });
}

function rendererDocument(value: string): string | undefined {
  const url = URL.parse(value);
  if (!url) return;
  url.hash = '';
  return url.href;
}

/** Give only the top-level Studio renderer access to preview grants. */
export function registerAnalyticsPreviewWindow(contents: WebContents, rendererUrls: string[]): void {
  const owned = new Map<string, Preview>();
  const expectedDocuments = new Set(rendererUrls.map(rendererDocument).filter(Boolean));
  const trusted = (event: IpcMainInvokeEvent) =>
    event.senderFrame === contents.mainFrame && expectedDocuments.has(rendererDocument(contents.getURL()));
  let generation = 0;

  const close = (url: string) => {
    const preview = owned.get(url);
    if (!preview) return;
    owned.delete(url);
    release(preview);
  };

  contents.ipc.handle(ANALYTICS_PREVIEW_CHANNELS.matches, async (event, value: unknown) => {
    const request = trusted(event) && validateRequest(value);
    return Boolean(request && (await resolveEntry(request)));
  });
  contents.ipc.handle(ANALYTICS_PREVIEW_CHANNELS.open, async (event, value: unknown) => {
    const request = trusted(event) && validateRequest(value);
    if (!request) return null;
    const startingGeneration = generation;
    const entry = await resolveEntry(request);
    if (!entry) return null;
    previewSession ??= initializeSession().catch((error: unknown) => {
      previewSession = undefined;
      throw error;
    });
    const partition = await previewSession;
    if (contents.isDestroyed() || generation !== startingGeneration) return null;
    const preview: Preview = { url: '', partition, grants: new Map(), reportHosts: new Map() };
    const host = addGrant(preview, { root: entry.root, scope: entry.scope });
    preview.url = previewUrl(host, entry.parts);
    owned.set(preview.url, preview);
    return { url: preview.url, partition: ANALYTICS_PARTITION };
  });
  contents.ipc.handle(ANALYTICS_PREVIEW_CHANNELS.close, (event, url: unknown) => {
    if (trusted(event) && typeof url === 'string') close(url);
  });

  let attaching: Preview | undefined;
  contents.on('will-attach-webview', (event, preferences, params) => {
    if (params.partition !== ANALYTICS_PARTITION) return;
    attaching = owned.get(params.src);
    if (!attaching || attaching.guest) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    Object.assign(preferences, {
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: false,
      navigateOnDragDrop: false,
    });
  });
  contents.on('did-attach-webview', (_event, guest) => {
    if (!attaching || guest.session !== attaching.partition) return;
    bindGuest(attaching, guest);
    const { url } = attaching;
    attaching = undefined;
    guest.once('destroyed', () => close(url));
  });

  const clear = () => {
    generation++;
    for (const url of owned.keys()) close(url);
  };
  contents.on('did-start-navigation', (_event, _url, sameDocument, mainFrame) => {
    if (mainFrame && !sameDocument) clear();
  });
  contents.once('destroyed', clear);
}
