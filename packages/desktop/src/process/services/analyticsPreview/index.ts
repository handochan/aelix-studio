/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { app, BrowserWindow, dialog, protocol, session, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { ipcBridge } from '@/common';
import { isChatFileRef } from '@/common/types/chatFile';
import {
  ANALYTICS_PREVIEW_CHANNELS,
  analyticsPathSegments,
  analyticsPreviewScope,
  isAnalyticsDocument,
  isGeneratedReportBody,
  isReportViewPath,
  originalReportScope,
  type AnalyticsPreviewRequest,
  type AnalyticsPreviewScope,
} from '@/common/utils/analyticsPreview';
import { locateAnalyticsDocument, previewFileType, readPreviewFile } from './files';
import {
  ANALYTICS_PARTITION,
  ANALYTICS_SCHEME,
  parsePreviewUrl,
  previewUrl,
  servePreview,
  type PreviewGrant,
} from './protocol';
import { matchesSavedFile, savedRevisionFiles } from './revision';

const MAX_REPORT_ORIGINS = 32;

type Preview = {
  url: string;
  partition: Electron.Session;
  guest?: WebContents;
  grants: Map<string, PreviewGrant>;
  reportHosts: Map<string, string>;
  rootKey: string;
  revoke: () => void;
};

/** Register before app ready so Chromium gives these documents real, distinct origins. */
export function registerAnalyticsPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ANALYTICS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const previews = new Map<string, Preview>();
const detachingRoots = new Set<string>();
const attachmentGenerations = new Map<string, number>();
const pendingDownloads = new WeakSet<Preview>();
let previewSession: Promise<Electron.Session> | undefined;

function getGrant(host: string): PreviewGrant | undefined {
  return previews.get(host)?.grants.get(host);
}

function downloadTarget(url: string) {
  const target = parsePreviewUrl(url);
  if (!target) return;
  const preview = previews.get(target.host);
  const grant = getGrant(target.host);
  const scope = originalReportScope(target.parts);
  if (!preview || !grant || !scope || !grant.permits(target.parts)) return;
  if (grant.scope.kind === 'report' && grant.scope.revision.join('/') !== scope.revision.join('/')) return;
  return { target, preview, grant, scope };
}

async function saveReportDownload(url: string, guest: WebContents): Promise<void> {
  const download = downloadTarget(url);
  if (!download || download.preview.guest !== guest) return;
  const { target, preview, grant, scope } = download;
  if (parsePreviewUrl(guest.getURL())?.host !== target.host || pendingDownloads.has(preview)) return;
  pendingDownloads.add(preview);
  try {
    const active = async () =>
      getGrant(target.host) === grant && (await grant.authorized()) && getGrant(target.host) === grant;
    if (!(await active())) return;
    const files = grant.scope.kind === 'report' ? grant.files : await savedRevisionFiles(grant.root, scope.revision);
    const saved = files?.get(target.parts.slice(scope.revision.length).join('/'));
    if (!saved) return;
    const bytes = await readPreviewFile(grant.root, target.parts);
    if (typeof bytes === 'number' || !matchesSavedFile(bytes, saved) || !(await active())) return;
    const owner = guest.hostWebContents && BrowserWindow.fromWebContents(guest.hostWebContents);
    if (!owner) return;
    const result = await dialog.showSaveDialog(owner, { defaultPath: target.parts.at(-1) });
    if (!result.canceled && result.filePath && (await active())) await writeFile(result.filePath, bytes);
  } finally {
    pendingDownloads.delete(preview);
  }
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
  isolated.on('will-download', (event, item, guest) => {
    event.preventDefault();
    void saveReportDownload(item.getURL(), guest).catch(() => {});
  });
  isolated.webRequest.onBeforeRequest((details, done) => {
    const target = parsePreviewUrl(details.url);
    const preview = target && previews.get(target.host);
    const localImage = details.resourceType === 'image' && details.url.startsWith('data:image/');
    done({
      cancel:
        !localImage && (!preview || preview.guest?.id !== details.webContentsId || details.resourceType === 'subFrame'),
    });
  });
  isolated.protocol.handle(ANALYTICS_SCHEME, (request) => {
    // Chromium omits Accept for a same-origin download link. Give its download
    // pipeline an empty response so will-download can cancel it and validate
    // the original in the main process. The hint does not authorize file I/O.
    if (request.method === 'GET' && !request.headers.has('accept') && downloadTarget(request.url)) {
      return new Response('', { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
    }
    return servePreview(request, getGrant);
  });
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

const rootKeyFor = (projectId: string, peId: string): string => JSON.stringify([projectId, peId]);

async function attachedFolder(projectId: string, peId: string): Promise<string | undefined> {
  if (detachingRoots.has(rootKeyFor(projectId, peId))) return;
  const project = await ipcBridge.project.get.invoke({ project_id: projectId });
  if (project?.project_id !== projectId) return;
  const entry = project.explorer.entries.find(({ pe_id }) => pe_id === peId);
  if (entry?.runtime_status === 'available' && path.isAbsolute(entry.display_path)) return entry.display_path;
}

function canNavigate(grant: PreviewGrant, parts: string[]): boolean {
  if (!grant.permits(parts)) return false;
  const mime = previewFileType(grant.scope, parts);
  if (grant.scope.kind === 'report') {
    return Boolean(
      (mime?.startsWith('text/html') || mime === 'image/svg+xml') &&
      grant.files?.has(parts.slice(grant.scope.revision.length).join('/'))
    );
  }
  return Boolean(mime?.startsWith('text/html'));
}

async function resolveEntry(request: AnalyticsPreviewRequest) {
  const { projectId, file } = request;
  const key = rootKeyFor(projectId, file.pe_id);
  const generation = attachmentGenerations.get(key);
  const requested = analyticsPathSegments(file.relative_path);
  if (!requested || !isAnalyticsDocument(file.relative_path)) return;
  const displayPath = await attachedFolder(projectId, file.pe_id);
  if (!displayPath) {
    throw new Error('Explorer root unavailable');
  }
  const explorerRoot = await realpath(displayPath);
  const filename = path.join(explorerRoot, ...requested);
  const canonical = await realpath(filename);
  const location = await locateAnalyticsDocument(filename);
  if (canonical !== filename && (location || (await locateAnalyticsDocument(canonical)))) {
    throw new Error('Analytics preview cannot follow links');
  }
  if (!location) {
    return;
  }
  const { root, scope, parts } = location;
  if (scope.kind === 'workspace' && isReportViewPath(parts) && !isGeneratedReportBody(parts)) {
    throw new Error('Open the original Report revision for this attachment');
  }
  if (!previewFileType(scope, parts)) throw new Error('Analytics preview file refused');
  if (scope.kind === 'workspace' && !/\.html?$/i.test(file.relative_path)) return;
  const permits = (target: string[]) => {
    const relative = path.relative(explorerRoot, path.join(root.directory, ...target));
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const authorized = async () => {
    try {
      return (
        (await attachedFolder(projectId, file.pe_id)) === displayPath &&
        (await realpath(displayPath)) === explorerRoot &&
        attachmentGenerations.get(key) === generation &&
        !detachingRoots.has(key)
      );
    } catch {
      return false;
    }
  };
  return { root, scope, parts, permits, authorized };
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

function navigationTarget(preview: Preview, url: string): string | Promise<string | undefined> | undefined {
  const current = parsePreviewUrl(preview.guest?.getURL() ?? '');
  const target = parsePreviewUrl(url);
  if (!current || !target || current.host !== target.host) return;
  const grant = preview.grants.get(current.host);
  if (!grant) return;
  if (canNavigate(grant, target.parts)) return url;
  if (grant.scope.kind !== 'workspace') return;

  // Workspace links to original Reports using the project's relative layout.
  // Only a navigation can grant a Report origin. Subresource requests never can.
  const scope = analyticsPreviewScope(target.parts.join('/'));
  if (scope?.kind !== 'report' || scope.project.length) return;
  return reportNavigation(preview, grant, scope, target.parts, url, current.host);
}

async function reportNavigation(
  preview: Preview,
  grant: PreviewGrant,
  scope: Extract<AnalyticsPreviewScope, { kind: 'report' }>,
  parts: string[],
  url: string,
  sourceHost: string
): Promise<string | undefined> {
  if (!grant.permits(parts)) return;
  const key = scope.revision.join('/');
  let host = preview.reportHosts.get(key);
  if (!host) {
    if (preview.reportHosts.size >= MAX_REPORT_ORIGINS) return;
    const files = await savedRevisionFiles(grant.root, scope.revision);
    const report = { ...grant, scope, files };
    if (!(await grant.authorized()) || preview.grants.get(sourceHost) !== grant || !canNavigate(report, parts)) return;
    host = preview.reportHosts.get(key);
    if (!host) {
      if (preview.reportHosts.size >= MAX_REPORT_ORIGINS) return;
      host = addGrant(preview, report);
      preview.reportHosts.set(key, host);
    }
  }
  const report = preview.grants.get(host);
  if (!report || !canNavigate(report, parts)) return;
  const parsed = new URL(url);
  return previewUrl(host, parts) + parsed.search + parsed.hash;
}

function bindGuest(preview: Preview, guest: WebContents): void {
  preview.guest = guest;
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  const load = (url: string): void => {
    void guest.loadURL(url).catch(() => {});
  };
  const follow = (target: string | Promise<string | undefined> | undefined) => {
    const from = guest.getURL();
    void Promise.resolve(target)
      .then((url) => {
        if (url && !guest.isDestroyed() && guest.getURL() === from && preview.grants.size) load(url);
      })
      .catch(() => {});
  };
  guest.on('will-frame-navigate', (event) => {
    const target = event.isMainFrame ? navigationTarget(preview, event.url) : undefined;
    if (target === event.url) return;
    event.preventDefault();
    follow(target);
  });
  guest.on('will-redirect', (event) => event.preventDefault());
  guest.setWindowOpenHandler(({ url }) => {
    follow(navigationTarget(preview, url));
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
    const files =
      entry.scope.kind === 'report' ? await savedRevisionFiles(entry.root, entry.scope.revision) : undefined;
    const grant = { ...entry, files };
    if (!canNavigate(grant, entry.parts)) return null;
    previewSession ??= initializeSession().catch((error: unknown) => {
      previewSession = undefined;
      throw error;
    });
    const partition = await previewSession;
    if (!(await entry.authorized())) return null;
    if (contents.isDestroyed() || generation !== startingGeneration) return null;
    const rootKey = rootKeyFor(request.projectId, request.file.pe_id);
    const preview: Preview = {
      url: '',
      partition,
      grants: new Map(),
      reportHosts: new Map(),
      rootKey,
      revoke: () => {
        close(preview.url);
        if (preview.guest && !preview.guest.isDestroyed()) void preview.guest.loadURL('about:blank').catch(() => {});
      },
    };
    const host = addGrant(preview, grant);
    preview.url = previewUrl(host, entry.parts);
    owned.set(preview.url, preview);
    return { url: preview.url, partition: ANALYTICS_PARTITION };
  });
  contents.ipc.handle(ANALYTICS_PREVIEW_CHANNELS.close, (event, url: unknown) => {
    if (trusted(event) && typeof url === 'string') close(url);
  });
  contents.ipc.handle(ANALYTICS_PREVIEW_CHANNELS.detach, async (event, projectId: unknown, peId: unknown) => {
    if (!trusted(event) || typeof projectId !== 'string' || typeof peId !== 'string') {
      throw new Error('Explorer detach refused');
    }
    const key = rootKeyFor(projectId, peId);
    if (detachingRoots.has(key)) throw new Error('Explorer detach already in progress');
    detachingRoots.add(key);
    try {
      await ipcBridge.project.removeFolder.invoke({ project_id: projectId, pe_id: peId });
      attachmentGenerations.set(key, (attachmentGenerations.get(key) ?? 0) + 1);
      for (const preview of new Set(previews.values())) {
        if (preview.rootKey === key) preview.revoke();
      }
    } finally {
      detachingRoots.delete(key);
    }
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
