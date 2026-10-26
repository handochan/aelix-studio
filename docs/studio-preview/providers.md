# Studio #5 native Provider registration

This change connects the existing Model/Provider settings surface to the public
native beta.2 libraries through a Studio-owned, sessionless stdio helper. No LLM
session is needed to register credentials. Aion Provider DB entries and WebUI
login credentials remain separate from native Provider authentication.

## Runtime and usage

The host operator selects the verified runtime prepared by the [baseline workflow](README.md):

```sh
export AELIX_STUDIO_RUNTIME=/absolute/path/to/prepared/studio-preview
# Optional: use the same explicit agent directory as an existing CLI installation.
export AELIX_CODING_AGENT_DIR=/absolute/path/to/native-agent-directory
bun start
# Or: bun run webui
```

Development also discovers `.local/studio-preview`; packaged hosts look under
`resources/studio-preview`. Runtime selection is host-owned, never renderer input.
The existing preparation venv is a qualification environment with absolute paths.
The installer workflow below creates a separate relocatable payload. Startup does
not download a runtime or select a system Python fallback.

In the existing Model settings page or modal:

1. Read the displayed native `auth.json` and `models.json` paths. Confirm that the
   CLI and other Studio hosts are not changing the same configuration.
2. Choose a native Provider and save a literal API key, or use OAuth when the
   native registry supports it. Device instructions, input, selection and manual
   authorization-code/redirect-URL callbacks are transient. Closing settings or
   its window cancels a pending login.
3. For a custom compatible endpoint, save the Provider ID, model, endpoint and
   API protocol first, then register its key. Credential-bearing URLs are refused.
4. Start a **new** Aelix conversation and send the first message. Its existing
   custom-agent/assistant path launches the selected native Provider/model with
   the same explicit CLI root. Existing sessions keep their cached credentials.

`configured/source` comes from native `ModelRegistry`/`AuthStorage`; it means
credentials are available, not that the remote Provider accepted them. Endpoint,
key and model access are exercised by the conversation. A failed response does
not switch Providers or automatically retry registration. Refresh status after an
ambiguous connection loss or cancellation; cancellation can race a commit.

## Boundaries

- The explicit CLI path is `get_agent_dir()/auth.json`, using
  `AELIX_CODING_AGENT_DIR` or `~/.aelix/agent`. The helper deliberately does not
  use the library's implicit `AELIX_AUTH_PATH`/XDG path. Native model configuration
  is read from the same agent directory; existing unrelated entries are preserved.
- The helper is embedded in Studio's host code and uses native sessionless APIs.
  It never supervises or sends private commands to a live ACP worker. The native
  four wheels remain unchanged; ACP is separately source-pinned and qualified.
- Desktop uses a dedicated preload IPC channel, restricted to the registered
  main window and exact Studio renderer URL. Navigation cancels its OAuth owner.
  The WebUI facade shares the existing listener and requires an actual backend
  login cookie, an allowed Origin, JSON and a custom request header. It does not
  trust the backend's local default identity or browser-supplied internal headers.
  Reverse proxies may explicitly configure the host-owned `AELIX_STUDIO_ORIGIN`.
- Secret requests bypass generic bridge logging and automatic HTTP replay.
  Native stdout/stderr and exception details are suppressed. Keys, callback
  input, URLs and device instructions are not put in Aion Provider DB, transcripts,
  operation ledgers or telemetry. OAuth data is cleared on terminal state.
- Helper deadlines, frame limits, EOF monitoring and bounded terminate/kill
  cleanup apply to its own processes. A single reader distributes OAuth input and
  EOF, including while a Provider waits without requesting input.
- Studio serializes its mutations and uses a stable sidecar lock between its
  cooperating helpers. File metadata revisions detect observed outside edits;
  OAuth checks again before committing. Malformed native auth JSON is refused
  rather than letting the public library treat it as an empty store.
- **Legacy CLI concurrent mutation remains unsupported.** The exclusive-use
  checkbox, sidecar and revision check cannot fix the public wheel's lock/rename
  race with a noncooperating writer. Native #46 remains the cross-process contract
  dependency. Windows uses a protected user/system/admin DACL for a new auth
  root and refuses mutation of an existing shared root. Its cooperative sidecar
  uses a byte-range lock; POSIX retains `flock`. No existing operator ACL is changed.

## Verification and delivery

Run the ordinary repository checks and the public-wheel qualifier:

```sh
bun run test
bunx tsc --noEmit
bun run lint
bun run format:check
bun run i18n:types
node scripts/check-i18n.js
bun run package
/path/to/prepared/native/bin/python -B scripts/studio-preview/providerSmoke.py \
  --runtime /path/to/prepared/studio-preview
```

The qualifier creates disposable HOME/auth/model/Studio roots and a synthetic
loopback Provider. It tests first registration/response, invalid key, unreachable
endpoint, separate Aion Provider DB, real WebUI cookie/Origin admission, external
renderer navigation, synthetic native OAuth success/cancel/EOF and revision
conflicts. It compares installed runtime bytes before/after and scans generated
logs/transcripts/databases for credential sentinels. Failed runs replace old
success receipts. Source/build hashes bind the receipt to the tested local bytes.

Results are recorded in [provider-acceptance.json](provider-acceptance.json);
generated detail and screenshots are in ignored `.local/studio-provider/`.
Independent review and reruns are recorded in [provider-review.md](provider-review.md).
The original synthetic checkpoint remains separate from the real-account and
macOS installer follow-up below. Other OS, mobile, closed-network and field gates
remain open. Issue #5 tracks repository delivery and final cross-surface acceptance;
a local test or PR alone does not establish Preview release delivery.

## macOS arm64 installer and real accounts

Build and verify the acceptance DMG without publishing or notarizing:

```sh
node scripts/studio-preview/packaging/build.mjs --runtime /path/to/prepared/studio-preview
/path/to/prepared/native/bin/python -B scripts/studio-preview/packaging/acceptance.py \
  --runtime /path/to/prepared/studio-preview \
  --dmg .local/provider-installer/artifacts/AionUi-2.2.2-mac-arm64.dmg
```

The builder copies the qualified standalone CPython base, separate native and ACP
sites, and license/metadata files outside asar. `-I -S -B` prevents user Python
paths and global site startup injection. An outside-asar CommonJS launcher runs the bundled Python directly, with
literal argument arrays and unchanged public entrypoints. AionCore resolves Node
from its bundled managed resources; the installed GUI receives a system-only PATH.
Windows does not depend on POSIX wrappers or `cmd.exe` argument parsing. Native wheel members and ACP
are re-audited before copying. Cached payload reuse requires current baseline,
prepared identity, build recipes, exact inventory, hashes and relative contained
symlinks. Archive a stale owned cache and rebuild; silent reuse is refused.

The qualifier mounts the DMG, copies its app into a disposable `~/Applications`
path containing spaces/Korean characters, verifies its ad-hoc signature and 309
unchanged native wheel members, then runs installed settings and response/error
scenarios. Standalone bundled Python and ACP also launch with source/original
interpreter reads denied and a system-only PATH. The normal Electron UI retains
its Chromium sandbox: nesting it inside `sandbox-exec` is not a clean-account
substitute and failed with macOS sandbox initialization errors. The WebUI check
uses a source-imported facade/helper and installed backend; it does not qualify
the app-owned compiled WebUI listener.

[Provider delivery evidence](provider-delivery.json) records actual OpenRouter
API-key registration, Codex OAuth consumption, separate real browser callback/token
exchange observation, and installed first response/restart results. Existing CLI
auth files are compared without writing them. Raw credentials are neither written
to receipts nor fingerprinted. A separate auth path alone does not establish new
OAuth enrollment. Token refresh is not exercised; valid access tokens are used
without rotating the original CLI refresh authority. The unmodified native common
callback page says “Anthropic” even for Codex; the stored Provider is independently
checked as `openai-codex`.

This is macOS arm64 ad-hoc acceptance, separate from Developer ID, notarization,
quarantine/Gatekeeper distribution, a clean OS account, cross-version upgrade and
user-data-preserving uninstall, other OS targets, and publication. The PR adds a
macOS installer qualification job; queued jobs are not completed CI evidence.

## Five-target Provider follow-up

PR #17 was accepted only on macOS arm64. Issue #5 is reopened for
`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` and `win32-x64`.
The current source adds portable helper stdin/locks, direct Python launch,
CPython 3.12.15 with a universal hashed dependency lock, and released AionCore
v0.2.2 assets for each target. The native beta.2 four wheels remain byte-identical.
The ACP pin includes the independently reviewed Windows stdio, authenticated
loopback permission transport and worker Job lifetime work in
[ACP PR #16](https://github.com/handochan/aelix-acp/pull/16).

The `Provider Preview installer` CI matrix prepares and qualifies actual native
and ACP processes on each matching runner, builds the current-host installer,
installs it, exercises the same Provider settings/first-response/error/OAuth
fixtures and removes only the owned installation. Formats are macOS DMG,
Linux Debian package and Windows per-user NSIS. Linux uses its real default
package path plus a separate Unicode/space runtime relocation probe; all five
use Unicode/space user-state roots. Existing Windows AionUi registrations or
processes and existing Linux package installations are refused before install.

```sh
python -B scripts/studio-preview/prepare.py --target win32-x64
node scripts/studio-preview/packaging/build.mjs --runtime .local/studio-preview
python -B scripts/studio-preview/packaging/acceptance.py --runtime .local/studio-preview
# On Linux, run the qualifier as an ordinary user under xvfb-run -a.
```

Installed host/preload/renderer JavaScript must match the current compiled
build; installed AionCore and 309 native wheel members must match the declared
artifacts. The runtime uses only its owned isolated Python imports. Windows
also re-audits the exact pywin32 bootstrap wheel and does not run its system
post-install script or arbitrary site startup files. Failure replaces prior
success receipts. Each target uploads its installer and acceptance detail.

This section describes the implementation and qualification contract. A target
is accepted only after its exact-head installer job and receipt pass. The older
`provider-delivery.json` remains historical macOS real-account evidence; CI
fixtures do not establish real remote OAuth/account acceptance on another OS.
Clean-account, cross-version upgrade, release signing/notarization, compiled
WebUI/mobile, offline and field gates stay tracked separately by Issue #8.
