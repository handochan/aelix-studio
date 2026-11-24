# Whole-app outbound gate

`studio-outbound.yml` builds and installs the current head on Linux x64 and arm64.
It traces the actual installed app, host, native, ACP and driver processes during
the existing synthetic loopback session/permission/restart qualification. It uses
no provider credentials. A separate 35-second production-default startup audit
removes the E2E/CI guards and uses fresh isolated user roots. Both audits seed
`update.autoCheck: false` in the same `aionui-config.txt` used by the settings
switch. No update-disable environment variable or address exemption is used. A
separate default-on check cancels HTTP requests before egress, requires a Studio
Releases request and verifies blocked networking produces no error dialog.
It still runs after a session audit failure, provided installation succeeded. Installation is a preceding, separate `dpkg` step;
network-free installer execution is not established by this runtime audit.

The gate is full verification: it runs for every PR (drafts too) except one that
changes only renderer UI, unit tests or docs and has no `full-verify` label, and for
manual runs and daily on main. `.github/actions/full-verify-gate/gate.mjs` holds the
skip set. An external attempt exits 86. Missing or
unparsed evidence, unsupported platforms and proxy configuration exit 87. Failed
connections, DNS on loopback, IPv4-mapped IPv6 and interrupted calls remain in
scope. A descendant-process TCP/UDP positive control must detect exactly two
attempts with no unparsed records. No address exceptions or report-only mode are
provided. CI artifacts retain counts, addresses and PID/comm, never socket
payloads or command arguments. Temporary strace output is deleted.

The compatibility CLI imports main's `scripts/studio-preview/fixtures/outboundAudit.py`
directly, with no scope selection. There is one parser, destination policy, lifecycle
policy and io_uring recorder for app-wide and host/native gates. `--whole-report`
is only the existing host-scoped diagnostic output; the separate app gate always
enforces the whole tree. Linux requires strace, bpftrace/BTF/tracepoints and sudo.
Capture failures/lost events remain fatal, with no syscall-only fallback.

Reports distinguish `outcome: evidence_incomplete` (exit 87) from
`external_attempts` (exit 86) and `command_failed`. Incomplete evidence may be
recaptured **once**, using the driver's fresh isolated state. Both reports and
first provisional counts survive in `*.capture-N.json` and `captureAttempts`;
a second incomplete capture fails with exit 87. A capture passes when it is
complete, the command succeeds, and enforcement-scope external attempts and
unparsed records are both zero.

The strace-gap path requires a complete, drained kernel capture with zero perf
event loss, no BPF recursion miss, and zero external attempts in the enforcement
scope. It allows exactly these strace gaps:

- `unknown_record` means the parser could not classify a strace record.
- `kernel_network_strace_entry_missing` means kernel evidence has a syscall
  entry that has no matching strace entry.
- `unknown_fork_result` means strace could not establish the fork result,
  including an unpaired clone restart.
- `register_stub` means the attributable strace record is missing register data.
- `result:close` means strace could not decode the return value of a close call.

The kernel-loss path allows only `io_uring_kernel_capture_incomplete`,
`kernel_network_capture_incomplete`, and `udp_socket_capture_incomplete` with
kernel reason `kernel_bpf_program_recursion_lost`. Any strace hole alongside
kernel loss blocks recapture. The kernel-loss path still permits provisional
unsent UDP association counts under the existing diagnostics checks. Perf event
loss (`io_uring_kernel_events_lost`, `lostEvents > 0`) also invalidates PID
namespace verification and blocks recapture.

Every issue and unparsed record must be covered by that list. Kernel namespace,
diagnostics, error counters and already-observed forbidden opcodes cannot
supply an unlisted failure alongside the loss. An external `accept4`, unreadable
`sendto` destination, unknown `connect` family, undecodable socket `write` peer,
or malformed TCP send peer fails the first capture. Known TCP/send/write,
forbidden opcodes, configuration refusal and command failure also prevent
replay. No parser, destination or socket-object policy is relaxed.

`AuditedSessions` passes each session's existing bound (480s for Provider and
permission) as `--capture-timeout`; attachment, command, drain, report parsing and hashing all share it.
Expiry is failure, never a retry reason. If analysis cannot finish, a minimal
failed report records `externalAttempts: null`, not zero, and acceptance does
not defer that unknown result. Cleanup has a separate 75s reserve; after cleanup
the unused activity budget is restored for remaining analysis.
The outer budget covers two such captures plus 30s report overhead; the
supervisor's own shutdown reserve is separate. Linux supervisors adopt detached
children, retain PID birth identities, terminate descendants before the root,
and keep rescanning after forced termination. They fail if the owned tree cannot
be cleared within its bounded grace. A standalone CLI audit also adopts and
cleans its descendants. Provider helper/host phases share 450s inside that 480s
capture budget, retaining their respective 300/240s maxima.

A recapture emits a GitHub warning annotation. `outbound-sessions.json` retains
`recaptures`, `captureAttempts` and per-capture/outer budgets on each session;
acceptance exposes `outboundRecaptures` and `recapturedAudits`. Passing after a
recapture is therefore visible rather than indistinguishable from one capture.
Interrupted acceptance/cleanup also preserves the current run's recapture
history in its failed receipt.

The two retained/preexisting socket **negative controls** use `--single-capture`:
their one-shot peer owns state outside the audited command, so replaying only
that command cannot recreate the fixture. They still require the first capture
to fail with exit 87 and the exact existing loss/retention evidence. This option
never turns incomplete evidence into a pass; ordinary product audits still
recapture once. The first #51 CI was cancelled after logs confirmed a second
`object-preexisting` invocation waiting for a peer that had already served its
one request. Real descriptor-exchange regression tests cover both controls.

For #51's x64 failure (job 133707594478), retained evidence proves a complete
kernel capture but not complete reconciliation: `unknown_record` on PID 15654
and a missing final strace `write` on PID 15953 (ordinal/lastOrdinal 4684, no
kernel return/socket hook). Raw traces were deleted by design. Whether that was
missing strace output or an unsupported parser shape **cannot be determined**
from that artifact. Unknown records now retain only a fixed shape, length and
sequence for diagnosis; they still fail closed. The arm64 `__sk_destruct`
`recursion_misses: 1` is a confirmed capture loss, including when observed after
detach. That check remains fatal for each capture; recapture mitigates the
intermittent collection failure rather than treating lost evidence as complete.

TCP connects and every UDP write/send attempt (including failed attempts through
inherited/duplicated/imported FDs) are denied outside loopback. `udpConnectOnly` (D)
requires a unique kernel socket-generation connect matching strace, zero protocol
or IP-output sends, final destructor entry/return before collection ends, and
complete loss-free namespace/task evidence. FD closure or CLOEXEC inference alone
never proves D. Missing free, preexisting objects, ambiguous matches and selected/
unselected object sharing fail. FIONCLEX, SCM_RIGHTS, pidfd_getfd and pending FD
ordering cannot defeat this object proof. See the shared
[policy and kernel sources](../studio-preview/fixtures/README.md#udp-socket-object-proof-issue-15-decision-6647325683).
The existing libuv operation allowlist and normal/SQPOLL CONNECT rejections remain
intact. Transport controls retain 0/86/86/87/87 and add real FIONCLEX+exec exit/send,
SCM_RIGHTS-send and pidfd_getfd-send controls.

```sh
python -I -B scripts/outbound-audit/audit.py --report .local/outbound/app.json -- command args
python -B -m unittest discover -s tests/studio-preview
python -B -m unittest discover -s tests/outbound-audit
python -I -B scripts/studio-preview/fixtures/outboundAudit.py --transport-controls .local/outbound/controls
```

Process names identify threads, not the originating product feature. Attribute
features by controlled comparisons and synthetic-only Chromium NetLog captures.
Raw NetLogs may contain URLs and request metadata and must not be uploaded.

The first revision intentionally exposes remaining default connections as a
failing gate. A passing unit test, offline functional smoke or host-only audit
never substitutes for this installed-app result. See the #15 inventory and its
remaining product decisions before promoting this draft.

## IPv6-only investigation harness

`ipv6Capture.py`, `ipv6Probe.cjs` and `ipv6Peer.py` are historical diagnostic tools at source `20019f5`;
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
undrained captures and failed UDP capture controls abort the experiment. The historical harness expects the pre-decision auditor/report format and exit
86/87. Reproducing that historical comparison requires the matching `20019f5`
auditor passed through `--audit-script`; it is not a current-policy validation
command. Current policy is qualified only by the shared auditor and transport
controls above. The recorded 76 connects / zero packets are retained in the study.

## Task evidence without verdict changes (#59 A, first PR)

`taskEvidence` contains numeric task and lifetime summaries counted by the
existing verdict parser and comparisons. It covers P/N/X/H/V, existing network
and ring/UDP results, and strace gap categories. A capture without an observed
comparison channel reports null for its counts. See the
[shared task-evidence schema](../studio-preview/fixtures/README.md#task-evidence-issue-59-a-first-pr).

The auditor removes each capture's scratch before required report writes or
recapture. It publishes completed counters for the final capture after the
required verdict and attempt history are saved. Aggregation checks its remaining
time periodically and between phases. Reports include observation time and the
reason when aggregation stops for a time reserve. An individual aggregation
call that stalls before the next check can still exhaust a required deadline.
