import type { App, Session, WebContents } from 'electron';
import { createServer } from 'node:net';
import { isExternalStudioResource } from '@/common/utils/urlValidation';

// electron-updater's HTTP executor uses a separate, in-memory session.
export const STUDIO_UPDATER_PARTITION = 'electron-updater';

const guarded = new WeakSet<Session['webRequest']>();

/** Apply the switch at request time, including redirects and subresources in document guests. */
export function protectStudioResources(
  session: Pick<Session, 'webRequest'>,
  offline: () => boolean,
  isNetworkRelay?: (url: URL) => boolean
): void {
  if (guarded.has(session.webRequest)) return;
  guarded.add(session.webRequest);
  session.webRequest.onBeforeRequest(({ url }, reply) => {
    if (!offline()) {
      reply({});
      return;
    }
    const target = URL.parse(url);
    if (!target) {
      reply({ cancel: true });
      return;
    }
    // These native routes can turn a loopback request into an external one.
    reply({ cancel: isNetworkRelay?.(target) === true || isExternalStudioResource(target) });
  });
}

let discardProxy: Promise<string> | undefined;

function localDiscardProxy(application: Pick<App, 'once'>): Promise<string> {
  discardProxy ??= new Promise<string>((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Studio offline proxy could not bind'));
        return;
      }
      application.once('will-quit', () => server.close());
      server.unref();
      resolve(`socks5://127.0.0.1:${address.port}`);
    });
  }).catch((error) => {
    discardProxy = undefined;
    throw error;
  });
  return discardProxy;
}

/** Backstop renderer preconnects, which can bypass URL request interception. */
async function setStudioRendererOffline(
  application: Pick<App, 'once'>,
  rendererSession: Pick<Session, 'setProxy' | 'closeAllConnections'>,
  offline: boolean
): Promise<void> {
  await rendererSession.setProxy(
    offline ? { mode: 'fixed_servers', proxyRules: await localDiscardProxy(application) } : { mode: 'system' }
  );
  // Enable only when every session has disconnected its connections.
  if (offline) await rendererSession.closeAllConnections();
  else await rendererSession.closeAllConnections().catch(console.error);
}

const managedSessions = new Set<Session>();
let rendererOffline = false;
let transportChange = Promise.resolve();

function serializeTransport(change: () => Promise<void>): Promise<void> {
  const pending = transportChange.then(change);
  transportChange = pending.catch(() => {});
  return pending;
}

/** Prepare a managed session before its first guest is allowed to navigate. */
export function prepareStudioRendererSession(
  application: Pick<App, 'once'>,
  session: Session,
  offline: () => boolean,
  isNetworkRelay?: (url: URL) => boolean
): Promise<void> {
  protectStudioResources(session, offline, isNetworkRelay);
  return serializeTransport(async () => {
    if (managedSessions.has(session)) return;
    if (rendererOffline) await setStudioRendererOffline(application, session, true);
    managedSessions.add(session);
  });
}

export function isManagedStudioRendererSession(session: Session): boolean {
  return managedSessions.has(session);
}

/** Set the policy before navigation, including frames embedded in a managed window. */
export function applyStudioRendererNetworkPolicy(contents: WebContents): void {
  if (managedSessions.has(contents.session)) {
    contents.setWebRTCIPHandlingPolicy(rendererOffline ? 'disable_non_proxied_udp' : 'default');
  }
}

/** Switch every app-managed renderer partition together, preserving explicit browser partitions. */
export function setStudioRenderersOffline(
  application: Pick<App, 'once'>,
  offline: boolean,
  getContents: () => WebContents[]
): Promise<void> {
  return serializeTransport(async () => {
    const sessions = [...managedSessions];
    const changed = await Promise.allSettled(
      sessions.map((session) => setStudioRendererOffline(application, session, offline))
    );
    const failure = changed.find((result) => result.status === 'rejected');
    if (failure) {
      await Promise.allSettled(
        sessions.map((session) => setStudioRendererOffline(application, session, rendererOffline))
      );
      throw failure.reason;
    }
    rendererOffline = offline;
    for (const contents of getContents()) applyStudioRendererNetworkPolicy(contents);
  });
}

type BackgroundNetworkApp = Pick<App, 'commandLine' | 'on' | 'configureHostResolver'>;

/** Disable unsolicited engine services while retaining user-configured network access. */
export function configureBackgroundNetworking(application: BackgroundNetworkApp): void {
  for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability']) {
    application.commandLine.appendSwitch(flag);
  }
  application.on('ready', () => {
    // Keep the OS resolver policy; do not silently upgrade it to a public DoH endpoint.
    application.configureHostResolver({ enableBuiltInResolver: false, secureDnsMode: 'off' });
  });
}
