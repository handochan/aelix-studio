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
  | { action: 'poll' | 'cancel'; operationId: string }
  /**
   * The extensions of the user's terminal `aelix`, read only (2026-11-22 user decision 4);
   * see `TerminalCliListing`. Needs neither the Studio runtime nor the change lock.
   */
  | { action: 'list_terminal' };

/** Where an installed distribution came from. Only file imports retain wheel bytes. */
export type FileExtensionOrigin = { kind: 'file'; artifact: string; wheel: string; sha256: string };

export type ExtensionOrigin =
  | FileExtensionOrigin
  | { kind: 'index'; indexUrl: string }
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

/** How a terminal CLI environment was found (see `TerminalCliListing`). */
export type TerminalCliFoundBy = 'uv_tool' | 'pipx' | 'launcher';

/** One `aelix.extensions` entry point of a terminal CLI environment: what its `extension list` shows. */
export type TerminalCliExtension = {
  /** Entry point name. */
  name: string;
  /** Distribution name as its metadata writes it. */
  distribution: string;
  version: string;
  /** The object reference the entry point names. */
  reference: string;
};

/**
 * Why part of an environment could not be read as a ledger. Codes only, never file content.
 * `ENTRY_POINTS_TOO_LARGE`: an `entry_points.txt` over 256 KiB, skipped.
 * `METADATA_UNREADABLE`: a distribution with extensions whose `METADATA` gives no name and version.
 * `DUPLICATE_DISTRIBUTION`: two `.dist-info` of one distribution; the first by name is used.
 * `DUPLICATE_ENTRY`: two distributions provide one entry name; both are listed.
 */
export type TerminalCliIssue =
  | 'ENTRY_POINTS_TOO_LARGE'
  | 'METADATA_UNREADABLE'
  | 'DUPLICATE_DISTRIBUTION'
  | 'DUPLICATE_ENTRY';

/**
 * One place the terminal CLI was found. Paths have the home directory as `~` and the user name
 * as `<user>` wherever it is a path segment; other absolute paths stay as they are.
 *
 * `listed`: a virtual environment with the CLI; `extensions` is its list. `location` is the
 * environment. `not_a_venv`: an `aelix` launcher runs a Python outside a virtual environment
 * (a system or `--user` pip install); it is not read, and `location` is that interpreter.
 * `unresolved_launcher`: an `aelix` launcher whose interpreter cannot be read from its first
 * line (`#!/usr/bin/env`, a binary); `location` is the launcher. `no_cli`: a launcher's virtual
 * environment without the CLI. `unreadable`: reading the environment failed.
 */
export type TerminalCliEnvironment = {
  status: 'listed' | 'not_a_venv' | 'unresolved_launcher' | 'no_cli' | 'unreadable';
  location: string;
  /** Every way it was found, in this order: uv tool, pipx, launcher. */
  foundBy: TerminalCliFoundBy[];
  /** The `aelix` launchers found for it, if any. */
  launchers: string[];
  /** The native version there (`listed` only). */
  nativeVersion?: string;
  extensions: TerminalCliExtension[];
  issues: TerminalCliIssue[];
  /** More than 2,000 distributions: the rest were not looked at. */
  truncated: boolean;
};

/**
 * How native's directory tier takes an entry of the global extension directory, first match
 * wins for a directory: `file`, a `*.py` file; `manifest`, a directory with `aelix-plugin.toml`;
 * `pyproject`, one whose `pyproject.toml` declares `[tool.aelix] extensions` with a path that
 * exists; `package`, one with `__init__.py`. `unknown`: its `pyproject.toml` falls outside the
 * strict rule Studio reads it by (ADR 9: one `[tool.aelix]` table with a one-line array of plain
 * strings; multi-line strings, quoted or dotted keys, inline tables, multi-line arrays, escapes
 * or repeats make it `unknown`), is too large, or declares more paths than are checked and none
 * of those checked exists. Manifests are not parsed: a broken one is listed and fails in native.
 */
export type TerminalGlobalExtensionKind = 'file' | 'manifest' | 'pyproject' | 'package' | 'unknown';

export type TerminalGlobalExtension = { name: string; kind: TerminalGlobalExtensionKind };

/**
 * The extensions of the user's terminal `aelix`, read from files only (ADR 9): nothing is
 * executed and no network is used. Studio does not know which `aelix` a terminal runs (that
 * depends on the shell's PATH), so every environment found is listed; none found is an empty
 * list with `searched`. Studio cannot install, remove or check these; that is ADR 9 phase 2.
 */
export type TerminalCliListing = {
  environments: TerminalCliEnvironment[];
  /** `<agent dir>/extensions`, which native loads in the terminal but not in Studio conversations. */
  globalExtensions: {
    location: string;
    /** `absent`: no such directory (or no agent directory Studio can place); `unreadable`: it cannot be read. */
    status: 'listed' | 'absent' | 'unreadable';
    extensions: TerminalGlobalExtension[];
    /** More than 500 entries, or a `pyproject.toml` with more than 64 paths: the rest were not looked at. */
    truncated: boolean;
  };
  /** Every directory looked in, for the screen to show when nothing was found. */
  searched: string[];
  /** More than 16 environments: the rest were not read. */
  truncated: boolean;
  /**
   * The scan did not end within its 5-second limit: the answer is what was read by then. False
   * only for a scan that ended before the limit.
   */
  timedOut: boolean;
};

export type ExtensionData =
  | ExtensionListing
  | ExtensionOperation
  | ExtensionRollback
  | ExtensionSettingsState
  | TerminalCliListing;

export type ExtensionReply =
  | { ok: true; data: ExtensionData }
  | { ok: false; code: ExtensionFailureCode; detail?: string[] };

/**
 * What the Studio host's own channel to the helper answers before the helper sees a request
 * (the desktop `studio:extensions` IPC channel and the WebUI `/api/studio/extensions` route):
 * `FORBIDDEN` for a caller that is not the Studio window or not a same-origin request,
 * `UNAUTHENTICATED` without a real WebUI login, `FRAME_LIMIT` for a request over 60 kB,
 * `UNAVAILABLE` when the host could not answer, and `CONNECTION_LOST` when the screen lost the
 * answer. A lost answer may follow a change that was made; the screen never sends it again.
 * `INSECURE_TRANSPORT`: the request carries proxy credentials over plain HTTP from another
 * machine without the acknowledgement; see `StudioExtensionsRequest`.
 */
export type StudioExtensionsTransportCode =
  | 'FORBIDDEN'
  | 'UNAUTHENTICATED'
  | 'FRAME_LIMIT'
  | 'UNAVAILABLE'
  | 'CONNECTION_LOST'
  | 'INSECURE_TRANSPORT';

/**
 * Whether the channel can carry a secret without it crossing a network in the clear:
 * `secure` for the desktop window and a WebUI over TLS or from this machine, `insecure` for a
 * WebUI over plain HTTP from another machine. Decided by the host from the connection itself
 * (for the WebUI, at the listener that accepted it), never from what a client sends. The
 * page's `Origin` can only lower a WebUI verdict: an `http:` origin on a host other than
 * localhost, 127/8 or [::1] (a reverse proxy on this machine serving the public over plain
 * HTTP), or no parseable origin, is `insecure`.
 */
export type StudioExtensionsTransport = 'secure' | 'insecure';

/**
 * A request as the screen sends it (2026-11-23 user decision: warn, then allow). The screen
 * sends `get_settings` first when it opens and takes `transport` from that reply before it
 * sends any secret. The channel puts `transport` on every reply it writes, its own refusals
 * included. Some replies cannot carry it: a WebUI request the listener refuses before the
 * route (an empty 403 for an origin it does not accept) and an answer the screen lost
 * (`CONNECTION_LOST`). The screen treats a reply without `transport` as `insecure`.
 *
 * On `insecure`, before a request that carries proxy credentials (`set_proxy_credentials`,
 * `proxyCredentials`, or a proxy address typed with them), the screen warns that they would
 * cross the network unencrypted; if the user goes on, it sends the request with
 * `acknowledgeInsecureTransport: true`. The channel still answers such a request without the
 * flag `INSECURE_TRANSPORT`, as a second line. It removes the flag before the helper sees the
 * request. Using saved credentials sends nothing secret and needs no flag.
 */
export type StudioExtensionsRequest = ExtensionCommand & { acknowledgeInsecureTransport?: true };

/**
 * A reply as the screen receives it: the helper's, or the channel's own refusal, with the
 * channel's `transport` (absent where the channel could not write it; see
 * `StudioExtensionsRequest`).
 */
export type StudioExtensionsReply = (ExtensionReply | { ok: false; code: StudioExtensionsTransportCode }) & {
  transport?: StudioExtensionsTransport;
};

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
