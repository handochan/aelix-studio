/**
 * Studio extension helper (Studio #32, D04 ADR). A screen module uses the service and the
 * request and reply types below and nothing else from this directory.
 */
export { ExtensionService, type ExtensionServiceOptions } from './service.js';
export { STATE_DIRECTORY, STATE_ENVIRONMENT } from './store/layout.js';
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
  ExtensionSource,
  ExtensionStatus,
} from './types.js';
