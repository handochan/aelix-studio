# Managed operation forwarding

This default-host delta connects Studio #16 to the opt-in ACP #12 operation
contract. It includes the previously accepted permission-recovery changes and
is applied to the original AionCore v0.2.2 archive, not to a locally modified
checkout. The public native beta.2 wheels remain unchanged.

- `forwarding.patch` is the complete host delta. `../host-recovery/default.json`
  pins every added, deleted and changed member, the original and final Cargo
  locks, license, compiler, build recipes and final closed source inventory.
  Historical `source.json`, `permission-restore.patch` and `qualification.json`
  remain evidence for the earlier permission candidate.
- `launch.cjs` enables the negotiated operation extension on Studio's own
  packaged Aelix route. Preparation copies it to the runtime's root as before;
  unrelated custom agents still use their actual advertised capabilities.
- `wire.py` exercises actual host HTTP/stdio, installed ACP and public native
  processes using a synthetic model. It checks admission/duplicate/conflict,
  original cancel scope, consent, bounded unsupported reverse requests, mode
  generation, hard host death, status-only recovery, session authentication,
  owner denial and cookie/CSRF rejection. Each launch uses Core's existing
  `--port 0` / listening-event path, while crash recovery retains the original
  data directory, operation fences and pre-crash native/model request baseline.
  Failed startup JSON records only fixed phase/boolean/exit-code diagnostics;
  raw local host logs are not uploaded. The final privacy check uses a live,
  read-only SQLite online snapshot of committed data, then stops the owned host
  and scans every remaining log/DB-prefix file as raw bytes. Snapshot/read failures
  fail the qualification. Before/after file counts and disappearing SQLite
  sidecars are recorded separately; live raw-sidecar inspection is not claimed.
  Desktop local mode intentionally retains
  AionCore's existing local default identity; it does not become an authenticated
  network service by enabling this feature.
- `smoke.py` and `smoke.mjs` exercise the existing Electron initial message,
  send box and command queue. The response-loss test accepts the actual HTTP
  request, then aborts its response and reloads the renderer. Native dispatch
  and model counts must remain three for the three distinct operations.

`packaging/acceptance.py` runs both qualifiers against each actually installed
DMG, DEB or NSIS app. The app receives a system-only PATH, resolves its own
default host, and uses the installed payload. The synthetic observer records
only method names and bounded operation identifiers, never prompt/auth/output.
Reports are in `.local/provider-installer/forwarding/` and are uploaded with
the other installer evidence. They are not real-provider, signed-release,
minimum-OS, upgrade, power-loss or field acceptance.

Renderer recovery uses persistent opaque identities and request digests, with
Web Locks serializing cooperating windows. Missing storage/locks or an
ambiguous original outcome fails closed. A new explicit user action may retry
the exact original key; neither a remount nor a missing native result creates
a replacement operation or ACP session. The queue's existing draft storage
continues to hold its user-authored body; the new operation envelope and host/
adapter ledgers contain only IDs, keyed fingerprints and allowlisted outcomes.

For a source-host reproduction, pass absolute paths to `--host`, `--python`,
`--adapter`, `--acp-source`, `--artifacts` and `--report` to each Python driver.
Use the prepared native Python. For installed acceptance additionally pass
`--payload` and set `PROVIDER_APP_EXECUTABLE` to the installed app executable.
Run installer acceptance through the existing packaging driver so identity,
payload, original wheel members, credentials and app cleanup are also checked.
