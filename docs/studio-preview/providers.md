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
The existing preparation venv is a qualification environment with absolute paths,
not a relocatable installer payload. This change does not package or publish an
installer, download a runtime at startup, or select a system Python fallback.

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
  four wheels and the accepted ACP source pin remain unchanged.
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
  dependency. Windows helper execution is explicitly unavailable; Linux and other
  host targets have not received this change's actual UI/installer qualification.

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
Real Provider authorization/OAuth, mobile, Linux/Windows host, final installers,
closed-network installation and field acceptance remain separate. Local work is
not push, PR, merge, CI or Preview release delivery; Issue #5 remains open for
repository delivery and the remaining actual acceptance.
