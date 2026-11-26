import type { App, Session } from 'electron';
import { createServer } from 'node:net';
import { isExternalStudioResource } from '@/common/utils/urlValidation';

// electron-updater's HTTP executor uses a separate, in-memory session.
export const STUDIO_UPDATER_PARTITION = 'electron-updater';

const guarded = new WeakSet<Session['webRequest']>();

/** Apply the switch at request time, including redirects and subresources in document guests. */
export function protectStudioResources(
  session: Pick<Session, 'webRequest'>,
  offline: () => boolean,
  isNativeBackend?: (url: URL) => boolean
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
    const nativeRelay =
      ['/api/fs/fetch-remote-image', '/api/system/check-update'].includes(target.pathname) &&
      isNativeBackend?.(target) === true;
    reply({ cancel: nativeRelay || isExternalStudioResource(target) });
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
export async function setStudioRendererOffline(
  application: Pick<App, 'once'>,
  rendererSession: Pick<Session, 'setProxy' | 'closeAllConnections'>,
  offline: boolean
): Promise<void> {
  await rendererSession.setProxy(
    offline ? { mode: 'fixed_servers', proxyRules: await localDiscardProxy(application) } : { mode: 'system' }
  );
  await rendererSession.closeAllConnections().catch(console.error);
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
