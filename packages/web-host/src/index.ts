import { startBackend } from './backend-launcher.js';
import { startStaticServer } from './static-server.js';
import type { WebHostOptions, WebHostHandle } from './types.js';

export type { AppMetadata, BackendBinaryResolver, WebHostOptions, WebHostHandle } from './types.js';
export { startStaticServer, stopStaticServer } from './static-server.js';
export type { StaticServerOptions, StaticServerHandle } from './static-server.js';
export { NativeAuthService, getNativeAuthService } from './studio-auth/service.js';
export type {
  NativeAuthCommand,
  NativeAuthReply,
  NativeAuthCatalog,
  NativeAuthOperation,
  NativeAuthSelection,
} from './studio-auth/types.js';
export {
  ExtensionService,
  STATE_DIRECTORY as EXTENSION_STATE_DIRECTORY,
  STATE_ENVIRONMENT as EXTENSION_STATE_ENVIRONMENT,
} from './studio-extensions/index.js';
export type {
  ExtensionCommand,
  ExtensionListing,
  ExtensionOperation,
  ExtensionReply,
  ExtensionRollback,
  ExtensionServiceOptions,
} from './studio-extensions/index.js';

// Backend launcher exports (M4)
export {
  BackendStartupCancelledError,
  BackendLifecycleManager,
  STUDIO_CREDENTIAL_HEADER,
  fetchStudioBackend,
  studioBackendCredential,
  buildSpawnArgs,
  buildSpawnEnv,
  findAvailablePort,
  startBackend,
  stopBackend,
} from './backend-launcher.js';
export type { BackendDirConfig, BackendLaunchOptions, BackendHandle, BackendStartOptions } from './backend-launcher.js';

/**
 * Start WebHost (main entry point).
 *
 * Orchestrates backend-launcher + static-server. web-host itself holds no
 * persistent configuration — callers (Electron main process, `bun run webui`
 * CLI) are responsible for resolving port / allowRemote from their own source
 * of truth (Electron ProcessConfig, CLI flags, env vars).
 */
export async function startWebHost(opts: WebHostOptions): Promise<WebHostHandle> {
  // 1. Start backend (M4)
  let backendHandle;
  if (opts.backend.kind === 'ownBackend') {
    backendHandle = await startBackend({
      app: opts.app,
      resolveBackend: opts.backend.resolveBackend,
      dataDir: opts.dataDir,
      logDir: opts.logDir,
      dirs: opts.dirs,
    });
  } else {
    // useExistingBackend: create a fake handle
    backendHandle = {
      port: opts.backend.port,
      stop: async () => {
        // no-op: external backend
      },
    };
  }

  let staticHandle;
  try {
    // 2. Start static-server (M5)
    staticHandle = await startStaticServer({
      staticDir: opts.staticDir,
      backendPort: backendHandle.port,
      userDataPath: opts.app.userDataPath,
      port: opts.port,
      allowRemote: opts.allowRemote ?? false,
    });
  } catch (err) {
    // If static-server fails, clean up backend
    await backendHandle.stop();
    throw err;
  }

  // 3. Return combined handle
  return {
    port: staticHandle.port,
    backendPort: backendHandle.port,
    localUrl: staticHandle.localUrl,
    get url() {
      return staticHandle.url;
    },
    get networkUrl() {
      return staticHandle.networkUrl;
    },
    get lanIP() {
      return staticHandle.lanIP;
    },
    async stop() {
      await staticHandle.stop();
      await backendHandle.stop();
    },
  };
}
