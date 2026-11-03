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

## IPv6-only investigation harness

`ipv6Capture.py`, `ipv6Probe.cjs` and `ipv6Peer.py` are isolated diagnostic tools;
they are not imported by Studio or the production gate. They refuse a namespace
with interfaces other than loopback at startup and require a disposable Docker
`--network none` container. The fixture disables spelling only to isolate this
probe; it does not implement dictionary bundling or change product defaults.

The image needs Python 3, iproute2, tcpdump, strace, Xvfb and the current Linux
Electron binary/dependencies. The measured local image was
`aelix-studio-15:ipv6`, built from the previous qualification image with
`apt-get install -y tcpdump iproute2 python3 util-linux`. See the
[report](../../docs/studio-outbound/ipv6-investigation.md) for exact engine and
capture versions, binary checksums and scope.

```sh
mkdir -p .local/ipv6-investigation
# The candidate is a separately checksum-verified archive, not a project upgrade.
docker run --rm --init --network none \
  --sysctl net.ipv6.conf.all.disable_ipv6=0 \
  --sysctl net.ipv6.conf.default.disable_ipv6=0 \
  --sysctl net.ipv6.conf.default.router_solicitations=0 \
  --cap-add NET_ADMIN --cap-add NET_RAW --cap-add SYS_ADMIN --cap-add SYS_PTRACE \
  --security-opt seccomp=unconfined --entrypoint python3 \
  -v "$PWD:/workspace:ro" -v "$PWD/.local/ipv6-investigation:/evidence" \
  aelix-studio-15:ipv6 /workspace/scripts/outbound-audit/ipv6Capture.py \
  --output /evidence/run \
  --candidate /workspace/.local/studio-15/ipv6/electron45/electron
```

Omit `--candidate` for the current engine only. The output directory must be new.
The 54-byte snap length stores Ethernet/IPv6 headers only. Dropped, incomplete or
undrained captures and failed UDP capture controls abort the experiment. The
unchanged auditor is separately required to retain exit 86/87; the research
command completing successfully does not mean the app audit passed.
