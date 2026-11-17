/**
 * Request and reply shapes of the Studio extension helper (Studio #32, D04 ADR 5.11).
 *
 * A screen module knows only these. It never sees pip, a venv or a generation path.
 */

/** A wheel on disk. `folder` names a directory whose other wheels may satisfy dependencies. */
export type ExtensionSource = { kind: 'file'; path: string; folder?: string };

export type ExtensionCommand =
  | { action: 'list' }
  | { action: 'install'; source: ExtensionSource }
  | { action: 'update'; name: string; source: ExtensionSource }
  | { action: 'remove'; name: string }
  | { action: 'rollback' }
  | { action: 'poll' | 'cancel'; operationId: string };

/** Where an installed distribution came from. Online origins are added with online installs. */
export type ExtensionOrigin = { kind: 'file'; artifact: string; wheel: string; sha256: string };

/**
 * `load_verified`: the extension was imported and its `setup()` ran when native was started
 * the way a conversation starts it. This is all the helper has checked. Whether what its
 * manifest declares (MCP servers, themes, hooks) is active in a conversation is not known
 * yet: a conversation loads an extension by module reference, which attaches no manifest,
 * and the form that does (decision B5, with its second load check) comes with the launcher.
 * Until then nothing is reported as fully ready.
 *
 * `manifest_unbound`: it loads, and native reports that its manifest does not bind, so what
 * it declares is certainly inert; the screen marks such an extension.
 *
 * `reinstall_needed`: the generation belongs to another bundle and is not used.
 */
export type ExtensionStatus = 'load_verified' | 'manifest_unbound' | 'reinstall_needed';

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
  /** Changes are not offered on this platform yet; see `ExtensionService`. */
  | 'UNSUPPORTED_PLATFORM'
  /** The result differs from what was asked for. */
  | 'REQUEST_MISMATCH'
  | 'LOAD_ERROR'
  | 'VERIFICATION_FAILED'
  | 'NO_CHANGE'
  | 'NOT_INSTALLED'
  | 'NOTHING_TO_ROLL_BACK'
  /** The generation is bound to another bundle; fitting it to this one is a later piece. */
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
