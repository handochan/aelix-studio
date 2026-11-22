import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProxyCredentialVault } from '../flow/online/proxy/credentials.js';
import { STATE_DIRECTORY } from '../store/layout.js';
import { ExtensionService, type ExtensionServiceOptions } from './service.js';

/**
 * The one extension helper service of a Studio host process (Studio #32, ADR 5.11).
 *
 * The desktop app's IPC channel and the WebUI route it serves share it, as they share the
 * native auth service: one change at a time per process, and a window or a signed-in WebUI
 * user can poll and cancel only its own. Each host configures it once, explicitly:
 * - the desktop main process after app `ready`, with its `safeStorage` vault (keychain where
 *   the OS has a secret store);
 * - the standalone WebUI with no vault, so proxy credentials are never kept (memory-only).
 * Until then requests answer `RUNTIME_UNAVAILABLE`, so neither host can be fixed to the other's
 * vault by accident.
 */
export type StudioExtensionsConfig = {
  /** The Studio user data directory; the helper's state is `<it>/aelix-runtime`. */
  userDataPath: string;
  /** The bundled Studio runtime; found as native auth finds it when left out. */
  runtime?: string;
  proxyVault?: ProxyCredentialVault;
  /** Where unexpected errors go; never a reply. */
  log?: ExtensionServiceOptions['log'];
  /** For tests: the rest of the service options. */
  service?: Partial<ExtensionServiceOptions>;
};

let shared: ExtensionService | undefined;

/**
 * The bundled runtime: `AELIX_STUDIO_RUNTIME`, else the packaged app's
 * `resources/studio-preview`, else a development checkout's `.local/studio-preview`.
 */
export function studioRuntimeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AELIX_STUDIO_RUNTIME) return env.AELIX_STUDIO_RUNTIME;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packaged = resources && path.join(resources, 'studio-preview');
  if (packaged && existsSync(path.join(packaged, 'manifest.json'))) return packaged;
  return path.resolve('.local/studio-preview');
}

/**
 * Configure the process's service. The first configuration stands: a second call returns the
 * service already configured, whatever it asks for, so a host cannot swap the vault (and so
 * the credential mode) under a running change.
 */
export function configureStudioExtensions(config: StudioExtensionsConfig): ExtensionService {
  shared ??= new ExtensionService({
    runtime: config.runtime ?? studioRuntimeDirectory(),
    root: path.join(config.userDataPath, STATE_DIRECTORY),
    ...(config.proxyVault ? { proxyVault: config.proxyVault } : {}),
    ...(config.log ? { log: config.log } : {}),
    ...config.service,
  });
  return shared;
}

/** The configured service, or undefined before the host configured it. */
export function getStudioExtensionService(): ExtensionService | undefined {
  return shared;
}

/** Stop what runs and forget the service (host shutdown, tests). */
export async function disposeStudioExtensions(): Promise<void> {
  const service = shared;
  shared = undefined;
  await service?.dispose();
}
