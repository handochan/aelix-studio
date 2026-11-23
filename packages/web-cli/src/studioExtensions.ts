import { configureStudioExtensions, disposeStudioExtensions, type ExtensionService } from '@aionui/web-host';

/**
 * The Studio extension helper of the standalone WebUI (Studio #32). There is no OS keychain
 * here: no vault, so proxy credentials are asked at each install and never kept
 * (memory-only). Call before the web host starts, so its route finds the service.
 */
export function startStandaloneExtensions(userDataPath: string): ExtensionService {
  return configureStudioExtensions({ userDataPath });
}

/** Stop what the helper runs; call when the WebUI stops. */
export function stopStandaloneExtensions(): Promise<void> {
  return disposeStudioExtensions();
}
