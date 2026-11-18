import { STUDIO_CREDENTIAL_HEADER, studioBackendCredential } from '@aionui/web-host';
import type { Session, WebContents } from 'electron';

const sessions = new WeakSet<Session>();

function isTrustedDocument(contents: WebContents, rendererUrls: ReadonlySet<string>): boolean {
  const value = contents.getURL();
  if (!value) return false;
  const url = new URL(value);
  url.hash = '';
  return rendererUrls.has(url.href);
}

export function protectStudioRequests(session: Session, windows: ReadonlyMap<number, ReadonlySet<string>>): void {
  if (sessions.has(session)) return;
  sessions.add(session);

  const redirects = new Set<number>();
  session.webRequest.onBeforeRedirect(({ id }) => redirects.add(id));
  session.webRequest.onCompleted(({ id }) => redirects.delete(id));
  session.webRequest.onErrorOccurred(({ id }) => redirects.delete(id));

  // Strip the credential even when Chromium follows a redirect to a different
  // destination. It is injected only for requests with a verified owner.
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === STUDIO_CREDENTIAL_HEADER) delete headers[name];
    }

    const url = new URL(details.url);
    const credential = studioBackendCredential(url);
    const contents = details.webContents;
    if (credential && !redirects.has(details.id) && contents && !contents.isDestroyed()) {
      const rendererUrls = windows.get(contents.id);
      const mainFrame = details.frame && details.frame === contents.mainFrame;
      const desktop =
        mainFrame &&
        !['mainFrame', 'subFrame'].includes(details.resourceType) &&
        rendererUrls &&
        isTrustedDocument(contents, rendererUrls);
      if (desktop) {
        // The supervisor has verified the originating Electron document.
        // Forward the canonical source expected by the loopback host.
        const origins = Object.keys(headers).filter((name) => name.toLowerCase() === 'origin');
        for (const name of origins) delete headers[name];
        if (origins.length || details.resourceType === 'webSocket' || details.method === 'OPTIONS') {
          headers.Origin = 'http://' + url.host;
        }
        headers[STUDIO_CREDENTIAL_HEADER] = credential;
      }
    }

    callback({ requestHeaders: headers });
  });
}
