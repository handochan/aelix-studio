import type { App } from 'electron';

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
