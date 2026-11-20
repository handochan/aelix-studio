/**
 * Request and reply shapes of the Studio extension helper (Studio #32, D04 ADR 5.11).
 *
 * A screen module knows only these. It never sees pip, a venv or a generation path.
 */

/** A wheel on disk. `folder` names a directory whose other wheels may satisfy dependencies. */
export type FileExtensionSource = { kind: 'file'; path: string; folder?: string };

export type OnlineExtensionSource =
  | { kind: 'index'; name: string; version?: string; indexUrl?: string }
  | { kind: 'git'; url: string; indexUrl?: string };

export type ExtensionSource = FileExtensionSource | OnlineExtensionSource;

export type ExtensionCommand =
  | { action: 'list' }
  | { action: 'install'; source: ExtensionSource; replaceIncompatible?: boolean }
  | { action: 'update'; name: string; source: FileExtensionSource }
  | { action: 'remove'; name: string }
  | { action: 'rollback' | 'reconcile_bundle' }
  | { action: 'poll' | 'cancel'; operationId: string };

/** Where an installed distribution came from. Only file imports retain wheel bytes. */
export type FileExtensionOrigin = { kind: 'file'; artifact: string; wheel: string; sha256: string };

export type ExtensionOrigin =
  | FileExtensionOrigin
  | { kind: 'index'; indexUrl: string }
  | { kind: 'git'; url: string; commit: string; indexUrl: string };

/**
 * Every installed extension passed two load checks: once by module reference, which imports
 * it and runs its `setup()` on the spot, and once exactly the way new conversations get it
 * (decision B5). The status says which way that is.
 *
 * `ready`: passed as a pack through the links directory. Its manifest binds in conversations:
 * what it declares (MCP servers, themes, hooks) is active as far as native allows.
 *
 * `manifest_unbound`: passed by module reference, because its pack does not fit that form (no
 * manifest on the entry module's path, one native does not bind, or one whose
 * `[plugin.entry] python` names something else). Its code loads; what its manifest declares
 * stays inert. The screen marks such an extension.
 *
 * `reinstall_needed`: the generation belongs to another bundle and is not used.
 */
export type ExtensionStatus = 'ready' | 'manifest_unbound' | 'reinstall_needed';

export type ExtensionEntry = {
  name: string;
  distribution: string;
  version: string;
  reference: string;
  origin: ExtensionOrigin | null;
  status: ExtensionStatus;
};

export type ExtensionListing = {
  current: string | null;
  previous: string | null;
  revision: number;
  /** A running conversation keeps the generation it started with. */
  appliesAt: 'new_session';
  /** There is a previous record. A different bundle requires revalidation before it can be restored. */
  rollbackAvailable: boolean;
  extensions: ExtensionEntry[];
};

export type ExtensionPhase =
  | 'checking'
  | 'preparing'
  | 'installing'
  | 'verifying'
  | 'switched'
  | 'failed'
  | 'cancelled';

/** Why an import set was refused before any installer ran. */
export type ImportRefusalCode =
  | 'NOT_A_WHEEL'
  | 'INVALID_WHEEL'
  | 'DIRECT_REFERENCE'
  | 'NOT_AN_EXTENSION'
  | 'STARTUP_CODE'
  | 'BUNDLE_OVERLAP'
  | 'BUNDLE_VERSION_CONFLICT';

export type ExtensionFailureCode =
  | ImportRefusalCode
  /** The installer ran and failed (native exit 1). The pip text is in `output`. */
  | 'INSTALLER_FAILED'
  /** The installer never ran (native exit 2). */
  | 'INSTALLER_NOT_RUN'
  /** Something Studio wrote into the generation was replaced. */
  | 'GENERATION_MODIFIED'
  /** The helper's state directory is not its own: a link, or somewhere else than its path says. */
  | 'UNSAFE_ROOT'
  /** The name fits more than one installed extension the way native compares names. */
  | 'AMBIGUOUS_NAME'
  /** This source is not offered on the platform; see `ExtensionService`. */
  | 'UNSUPPORTED_PLATFORM'
  /** The result differs from what was asked for. */
  | 'REQUEST_MISMATCH'
  | 'LOAD_ERROR'
  | 'VERIFICATION_FAILED'
  | 'NO_CHANGE'
  | 'NOT_INSTALLED'
  | 'NOTHING_TO_ROLL_BACK'
  | 'ONLINE_INSTALL_DISABLED'
  /** The generation could not be used with the current bundle. */
  | 'BUNDLE_CHANGED'
  /** Another change is running, here or in another Studio process. */
  | 'BUSY'
  /** The current generation changed while this one was prepared. */
  | 'CONFLICT'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'RUNTIME_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export type ExtensionOperation = {
  operationId: string;
  action: 'install' | 'update' | 'remove';
  phase: ExtensionPhase;
  code?: ExtensionFailureCode;
  /** Reasons in plain English, for logs and support. The screen maps `code` to its own text. */
  detail?: string[];
  /** The end of the installer output, length-limited. */
  output?: string;
  /** The generation that became current. */
  generation?: string;
};

export type ExtensionRollback = { current: string; previous: string | null; revision: number };

export type ExtensionData = ExtensionListing | ExtensionOperation | ExtensionRollback;

export type ExtensionReply =
  | { ok: true; data: ExtensionData }
  | { ok: false; code: ExtensionFailureCode; detail?: string[] };

/** A failure with a code the caller can show. Anything else is reported as `INTERNAL`. */
export class ExtensionFailure extends Error {
  constructor(
    readonly code: ExtensionFailureCode,
    readonly detail: string[] = [],
    readonly output?: string
  ) {
    super(detail[0] ?? code);
    this.name = 'ExtensionFailure';
  }
}
