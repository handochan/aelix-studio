/**
 * Studio extension helper (Studio #32, D04 ADR). A screen module uses the service and the
 * request and reply types below and nothing else from this directory.
 */
export { ExtensionService, type ExtensionServiceOptions } from './host/service.js';
export {
  configureStudioExtensions,
  disposeStudioExtensions,
  getStudioExtensionService,
  studioRuntimeDirectory,
  type StudioExtensionsConfig,
} from './host/shared.js';
export { handleStudioExtensions, STUDIO_EXTENSIONS_ROUTE } from './host/facade.js';
export { MEMORY_ONLY_VAULT, type ProxyCredentialVault } from './flow/online/proxy/credentials.js';
export {
  locateStudioExtensionLayout,
  resolveStandaloneStudioUserDataPath,
  STATE_DIRECTORY,
  STATE_ENVIRONMENT,
} from './store/layout.js';
export type {
  ExtensionCommand,
  ExtensionData,
  ExtensionEntry,
  ExtensionFailureCode,
  ExtensionListing,
  ExtensionOperation,
  ExtensionOrigin,
  ExtensionPhase,
  ExtensionReply,
  ExtensionRollback,
  ExtensionSettings,
  ExtensionSettingsState,
  ExtensionSource,
  ExtensionStatus,
  ProxyCredentialMode,
  ProxyCredentials,
  StudioExtensionsReply,
  StudioExtensionsRequest,
  StudioExtensionsTransportCode,
} from './types.js';
