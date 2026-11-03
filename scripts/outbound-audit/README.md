# Whole-app outbound gate

`studio-outbound.yml` builds and installs the current head on Linux x64 and arm64.
It traces the actual installed app, host, native, ACP and driver processes during
the existing synthetic loopback session/permission/restart qualification. It uses
no provider credentials. A separate 35-second production-default startup audit
removes the E2E, CI and update-disable guards and uses fresh isolated user roots.
It still runs after a session audit failure, provided installation succeeded. Installation is a preceding, separate `dpkg` step;
network-free installer execution is not established by this runtime audit.

The gate runs on draft PRs too. An external attempt exits 86. Missing or
unparsed evidence, unsupported platforms and proxy configuration exit 87. Failed
connections, DNS on loopback, IPv4-mapped IPv6 and interrupted calls remain in
scope. A descendant-process TCP/UDP positive control must detect exactly two
attempts with no unparsed records. No address exceptions or report-only mode are
provided. CI artifacts retain counts, addresses and PID/comm, never socket
payloads or command arguments. Temporary strace output is deleted.

`destinationPolicy.py` is copied byte-for-byte from PR #35's
`fixtures/outboundAudit.py` at `a141d456759e48636e6972cb1f458b1a5644c7d5`.
PR #35 later split its parser into a scoped module and changed its API (head
`28ddf60c893d87eca354973bf1518dbb4502df0e`). This private snapshot avoids editing
or conflicting with those shared files. The wrapper always enforces the whole
command tree; it does not inherit a host-only or report-only selection.

Run on Linux with strace 6.1 or newer:

```sh
python -B scripts/outbound-audit/audit.py --report .local/outbound/app.json -- command args
python -B -m unittest discover -s tests/outbound-audit
```

Process names identify threads, not the originating product feature. Attribute
features by controlled comparisons and synthetic-only Chromium NetLog captures.
Raw NetLogs may contain URLs and request metadata and must not be uploaded.

The first revision intentionally exposes remaining default connections as a
failing gate. A passing unit test, offline functional smoke or host-only audit
never substitutes for this installed-app result. See the #15 inventory and its
remaining product decisions before promoting this draft.
