/**
 * Request and reply shapes of the Studio extension helper (Studio #32, D04 ADR 5.11).
 *
 * A screen module knows only these. It never sees pip, a venv or a generation path.
 */

/** A wheel on disk. `folder` names a directory whose other wheels may satisfy dependencies. */
export type FileExtensionSource = { kind: 'file'; path: string; folder?: string };

/**
 * `subdirectory` installs the project in that directory of the repository. It is a relative
 * path of plain names joined by `/`; Studio fetches the repository first, checks the path
 * against the checkout and installs from there. A `#subdirectory=` URL fragment stays refused.
 */
export type OnlineExtensionSource =
  | { kind: 'index'; name: string; version?: string; indexUrl?: string }
  /** A package name with optional comma-separated version clauses, saved as entered. */
  | { kind: 'index'; requirement: string; indexUrl?: string }
  | { kind: 'git'; url: string; subdirectory?: string; indexUrl?: string };

export type ExtensionSource = FileExtensionSource | OnlineExtensionSource;

/**
 * What the user set in Studio's extension settings. They apply to name and git installs only;
 * a file import always runs offline whatever they say.
 */
export type ExtensionSettings = {
  /** False refuses name and git installs before any process starts. */
  onlineInstall: boolean;
  /**
   * The HTTP(S) proxy the user typed, as `http://host:port` or `https://host:port`, or null to
   * connect directly. Online installs use this proxy and no other: system and environment
   * proxies are never followed. It never holds a user name or password: an address typed with
   * them is split, and the credentials go to `set_proxy_credentials`' store (see
   * `ProxyCredentialMode`).
   */
  proxy: string | null;
  /**
   * The proxy asks for a user name and password. Saved credentials are used when there are
   * any; otherwise an online install needs them with the request (`proxyCredentials`), or it
   * ends with `PROXY_CREDENTIALS_REQUIRED`. False while `proxy` is null.
   */
  proxyAuthentication: boolean;
  /**
   * True lets git installs use the user's SSH agent, keys and SSH configuration and the Git
   * credential helpers the user configured. False (the default) keeps them out.
   */
  privateGit: boolean;
};

/**
 * Where proxy credentials can be kept.
 *
 * `keychain`: the desktop app, where Electron `safeStorage` encrypts them with the OS keychain
 * (macOS Keychain, Windows DPAPI, Linux libsecret or KWallet); `set_proxy_credentials` saves.
 *
 * `memory-only`: the standalone WebUI, or a Linux desktop whose `safeStorage` has no secret
 * store (`basic_text`) or no encryption. Nothing is saved: each online install takes the
 * credentials with its request and they live only as long as that change.
 */
export type ProxyCredentialMode = 'keychain' | 'memory-only';

/**
 * A user name and password for the proxy, as the user typed them (not percent-encoded).
 * Printable ASCII only, and a user name without `:`; anything else is `INVALID_INPUT`. Sent as
 * these fields they are taken as they are; typed into a proxy address they are percent-decoded
 * once, as a URL's user part.
 */
export type ProxyCredentials = { username: string; password: string };

export type ExtensionSettingsState = {
  settings: ExtensionSettings;
  /** Whether credentials can be saved here; see `ProxyCredentialMode`. */
  credentialMode: ProxyCredentialMode;
  /** Credentials for the current proxy are saved. The secret itself is never returned. */
  hasSavedCredentials: boolean;
  /**
   * The stored settings could not be read. Until settings are saved again, the values above
   * are the closed ones (no online installs, no proxy, no private Git).
   */
  unreadable: boolean;
  /** Studio itself turns online installs off; the setting cannot turn them on. */
  onlineInstallLocked: boolean;
};

export type ExtensionCommand =
  | { action: 'list' }
  /**
   * `proxyCredentials` are used for this install only and never saved: required in
   * `memory-only` mode when the proxy asks for credentials (where they also drop credentials a
   * keychain saved), and they take the place of saved ones in `keychain` mode. They are for the
   * proxy of the settings when the request arrives (`PROXY_CHANGED` otherwise). No installer
   * sees them: a loopback proxy of the change signs in for pip and Git. File imports and
   * updates run offline and take none.
   */
  | {
      action: 'install';
      source: ExtensionSource;
      replaceIncompatible?: boolean;
      proxyCredentials?: ProxyCredentials;
    }
  | { action: 'update'; name: string; source: FileExtensionSource }
  /** Re-resolve the installed source. allowUnpin confirms a legacy index origin with no saved requirement. */
  | { action: 'upgrade'; name: string; allowUnpin?: boolean; proxyCredentials?: ProxyCredentials }
  | { action: 'remove'; name: string }
  | { action: 'set_default'; extensionId: string; enabled: boolean }
  | { action: 'rollback' | 'reconcile_bundle' }
  | { action: 'get_settings' }
  /**
   * Changes only the fields given. Send every field after `unreadable`. A proxy typed with a
   * user name and password is split: the address is stored without them, `proxyAuthentication`
   * turns on (sending it false with them is `INVALID_INPUT`) and the credentials replace saved
   * ones: saved in `keychain` mode, dropped with the old ones in `memory-only` mode. Turning the
   * proxy off or changing its scheme, host or port drops saved credentials and turns
   * `proxyAuthentication` off.
   */
  | { action: 'set_settings'; settings: Partial<ExtensionSettings> }
  /** Save credentials for the current proxy (`keychain` mode only) and turn `proxyAuthentication` on. */
  | { action: 'set_proxy_credentials'; credentials: ProxyCredentials }
  /** Drop saved credentials. `proxyAuthentication` stays as it is. */
  | { action: 'clear_proxy_credentials' }
  | { action: 'poll' | 'cancel'; operationId: string };

/** Where an installed distribution came from. Only file imports retain wheel bytes. */
export type FileExtensionOrigin = { kind: 'file'; artifact: string; wheel: string; sha256: string };

export type ExtensionOrigin =
  | FileExtensionOrigin
  /** Missing requirement means the original version constraint is unknown (legacy generation). */
  | { kind: 'index'; indexUrl: string; requirement?: string }
  | { kind: 'git'; url: string; commit: string; indexUrl: string; subdirectory?: string };

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
  /** Availability based on the source, platform and current generation. Combine with get_settings. */
  upgrade?: 'available' | 'pinned' | 'confirmation_required';
  /** Grouped pack aliases share one ACP ID and one app default. Legacy generations have neither. */
  managedId?: string;
  defaultEnabled?: boolean;
};

export type ExtensionListing = {
  current: string | null;
  previous: string | null;
  revision: number;
  /**
   * A change applies when an adapter next starts: a new conversation, or an existing one whose
   * adapter restarts. A running adapter keeps the generation it started with.
   */
  appliesAt: 'next_adapter_start';
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
  | 'already_latest'
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
  | 'MANAGED_EXTENSION_INVALID'
  | 'VERIFICATION_FAILED'
  | 'NO_CHANGE'
  | 'NOT_INSTALLED'
  /** A file or an unrecorded source cannot be upgraded online. */
  | 'UPGRADE_UNAVAILABLE'
  /** The saved requirement names an exact version or the Git ref names a full commit SHA. */
  | 'PINNED'
  /** A legacy index record lost the requirement. Retry only after the user confirms allowUnpin. */
  | 'PIN_UNKNOWN'
  | 'NOTHING_TO_ROLL_BACK'
  | 'ONLINE_INSTALL_DISABLED'
  /** The stored extension settings cannot be read; online installs wait until they are saved again. */
  | 'SETTINGS_UNREADABLE'
  /** The proxy is not an `http://` or `https://` address of a host and an optional port. */
  | 'INVALID_PROXY'
  /**
   * The proxy asks for credentials and none came: none are saved (or the saved ones cannot be
   * read) and the request carried none. The screen asks the user and sends `proxyCredentials`.
   */
  | 'PROXY_CREDENTIALS_REQUIRED'
  /** Credentials cannot be saved here (`memory-only` mode); send them with each install instead. */
  | 'PROXY_CREDENTIALS_NOT_STORED'
  /**
   * The user's proxy refused the credentials (407) and the install failed. Saved credentials
   * stay as they were; the screen asks again and sends `proxyCredentials` or saves new ones.
   */
  | 'PROXY_CREDENTIALS_REJECTED'
  /**
   * The proxy changed (another Studio process saved settings) after the install was checked.
   * The credentials it carried were for the earlier address and were not used: ask again.
   */
  | 'PROXY_CHANGED'
  /** Studio could not fetch the repository or find the requested revision. Git's text is in `output`. */
  | 'GIT_FETCH_FAILED'
  /** The subdirectory is not a real directory inside the fetched repository (missing, a file, a link). */
  | 'SUBDIRECTORY_INVALID'
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
  action: 'install' | 'update' | 'upgrade' | 'remove';
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

export type ExtensionData = ExtensionListing | ExtensionOperation | ExtensionRollback | ExtensionSettingsState;

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
