# Synthetic model and permission fixtures

These test-only fixtures are derived from `handochan/aelix-acp` commit
`117cf6c9d536c4aa98b1f3a6481c12464584960c` (`scripts/beta2_wire.py`,
`qualify_permissions.py`, `permission_fixture_extension.py`), under Apache-2.0.
Copyright Aelix Contributors; the repository LICENSE applies. They now live in
Studio because ACP #20 retired its public-beta.2 qualification harness.

Only the synthetic HTTP model, owned environment setup and permission-effect
extension are retained. They do not provide native compatibility or production
execution behavior. Credentials are synthetic, state is temporary, and the model
listens on loopback. Installed source-wheel integrity is checked separately by
`../packaging/runtime.py`; fixture reuse is not public-wheel acceptance.

`outboundAudit.py` is derived from the host release source
`72e0e92008067531cf3aa673a6b62f16a87cc6fa`,
`scripts/release/outbound_audit.py` (Apache-2.0; original SHA-256
`80d15a8056a498b4f2d8555ae97a53c800881b8a0903c4a75c4b3af1895b8caa`).
Studio adds PID/comm and fork/exec parsing in `outboundScope.py` and optional
process-tree selection. Namespaced fork return values are translated into the
tracer PID namespace before constructing edges, so sandbox-local PID reuse
cannot move a child into the wrong tree. Default CLI behavior stays whole-command enforcement:

```sh
python -I -B scripts/studio-preview/fixtures/outboundAudit.py --report all.json -- command
```

The Studio #28 acceptance boundary is explicit (user decision 2026-11-03):

```sh
python -I -B scripts/studio-preview/fixtures/outboundAudit.py \
  --scope-executable /path/to/aelix-studio-host \
  --scope-executable /path/to/installed/python3 \
  --require-executable /path/to/aelix-studio-host \
  --report host-native.json --whole-report app.json -- command
```

Roots are successful execs of the selected absolute executable paths (existing
symlinks are resolved). All forks/threads and re-executed/reparented descendants
remain selected regardless of later executable or comm names. A matching basename
alone is insufficient. Selection conservatively covers the root PID's whole
observed lifetime. Missing required roots, missing fork edges/children, incomplete task lifecycles, ambiguous PID reuse,
unsupported exec attribution and malformed lineage fail closed. `/proc/self/exe`
is resolved from captured executable inheritance at fork, not from comm names. The fixed fixture
uses direct installed executable paths; a transient alias below the host remains
covered by its ancestry. This is an audit scope, not a runtime sandbox.

The selected-tree report blocks on any external attempt or unparsed record.
Unparsed network records of a known non-selected PID remain in the whole-app
report, while ambiguous process attribution blocks the selected gate. The latter
report has `enforcement: report-only` and never changes the gate result. Both
reports include counts, PID/parent/comm, root identities and parser source hashes.
Classification failures also include fixed reason codes and numeric task IDs in
`classificationIssues`; no raw trace text or executable path is included.
An exact `???( <unfinished ...>` register-decoding stub immediately followed by
that task's signal-death record remains an unparsed record of its captured PID.
This strace [register-read fallback](https://github.com/strace/strace/blob/v6.1/src/syscall.c#L1355)
cannot resume after task death. It is attributable only with complete fork
ancestry, no pending fork/exec and no intervening/subsequent task records. The
same stub in a selected tree still fails; whole-command enforcement also fails.
Missing ancestry/lifecycle, interrupted fork/exec, other unknown records or any
ambiguous attribution remain classification errors that block every scope.
No network addresses are newly exempted: only loopback/Unix IPC is allowed, with
DNS port 53 counted as external even on loopback. Proxy preflight remains strict.

Linux installer acceptance selects the pinned installed host and installed Python,
covering ACP/native children plus independent native helpers. Four separate
functional sessions use the same scoped auditor: `acp-version`, `core-version`,
`provider` (Provider UI/LAN and helper qualification), and `permission` (21 checks,
including restarts and failed Yolo-to-Ask transition). Each requires zero selected
external attempts, unparsed records and classification errors, plus observed
required executable roots. Windows/macOS run these functionally without an
OS-level zero-attempt claim.

`acceptance.json.auditedSessions` lists the audited sessions and report hashes;
`permission/outbound-sessions.json` also records failures as they occur. Session
reports are `outbound-<session>.json` and `outbound-app-<session>.json`; permission
retains the original `outbound.json` / `outbound-app.json` names. Receipt counts
aggregate the functional sessions; positive controls are separate in
`outboundControls`. Independent functional evidence is completed even after an
audit failure; failed sessions remain failed in the ledger, the final receipt is
failed, and qualification exits nonzero. No failed audit can become green.
The legacy single-report hashes still name permission's
reports. The existing workflow artifact glob retains all reports and the ledger.

Installed-native direct/child TCP/UDP controls each require two attempts, unparsed
0 and exit 86. A third control selects **only the installed host** and asks its MCP
test API to launch an installed-Python child making the same TEST-NET attempts.
It verifies the captured fork ancestry from that exact child's PID to the host,
with no independent native root that could hide a missing host edge. The fixture
awaits bundled-runtime validation before shutdown instead of cancelling startup
probes. Image fetch
is unsuitable here because the host's image-host whitelist rejects TEST-NET URLs
before connecting. This uses an explicit test-only MCP command, without npx.
The host control runs under `sudo unshare --net`, with only loopback enabled and
no default routes; it asserts that isolation before starting the host. No TEST-NET
packet can leave an external interface. It is separate from functional runs and
requires exit 86, two attempts, unparsed/classification 0 and a graceful host exit.
Namespace setup failure fails qualification; there is no permissive fallback.

Linux io_uring auditing pairs the syscall trace with a sudo **bpftrace** recorder.
It records `io_uring:io_uring_create`, `io_uring_submit_req` (or the older
`io_uring_submit_sqe`), and `io_uring_req_failed` for SQEs rejected before normal
submission. Scheduler fork/exec/exit tracepoints bound the command's descendant
domain. SQPOLL task identity is read from the ring's running-kernel BTF layout at
creation; these kernel tasks are included in lifecycle accounting even when
they do not pass through the ordinary fork tracepoint. No process-name filter or address exception selects ring traffic.

The recorder starts before a stopped, unprivileged strace root is resumed. It
records creator PID/TGID, ctx, fd, flags, issuing task and opcode. Running-kernel
BTF supplies PID structure offsets; kernel initial-namespace IDs are normalized
to the auditor/strace namespace, including nested renderer namespaces. SQPOLL
submissions use ctx ownership rather than the kernel thread's process name.
Published ctx IDs are capture-local opaque identifiers with creation generations,
not raw kernel pointers. Ring fd/flags/TGID must match successful strace setup;
missing or inconsistent rings fail. Denied setup cannot create a usable ring and
must have no corresponding create event. Imported/unattributed descriptors,
registered-ring indices, unsupported setup modes or borrowed ring-buffer mappings and ambiguous identity
fail closed. Descriptor inheritance, dup, close, mmap and exec are reconciled.

The fixed allowlist is the explicit enum and submission sites in
[Node v24.11.0's libuv Linux source](https://github.com/nodejs/node/blob/v24.11.0/deps/uv/src/unix/linux.c#L138-L151):
`READV`, `WRITEV`, `FSYNC`, `OPENAT`, `CLOSE`, `STATX`, `EPOLL_CTL`, `RENAMEAT`,
`UNLINKAT`, `MKDIRAT`, `SYMLINKAT`, `LINKAT`, `FTRUNCATE`. The pinned source uses
vectored read/write, so ordinary `READ`/`WRITE` opcodes are not automatically added.
Every other opcode fails, including `CONNECT`, `SEND*`, `SENDMSG*`, `SOCKET`,
`ACCEPT`, `URING_CMD` and unknown/future values. Known outside-tree rings/operations
remain only in the whole-app report; unresolvable ownership is globally blocking.
Per-session `ioUring` reports include opcode counts, ring ownership/submissions,
namespace evidence, kernel event counters and capture status.

An ordinary new client socket must establish its peer through traced `connect`,
or a rejected ring `CONNECT`, before connected `READV`/`WRITEV` can send data.
Server-side connections can instead originate in `accept`/`accept4`, so these are
also traced: non-loopback or unresolved accepted peers fail selected-tree
qualification. Unconnected UDP vectored writes cannot choose a peer; destination
selecting `SEND*` ring operations are rejected. Previously connected inherited or
SCM-passed sockets retain the S3 limitation below. Allowed file operations do not
claim packet/device or remote-filesystem transport auditing; the fixture uses
owned local files and loopback transports. This is not a runtime sandbox.

Missing tracepoints/BTF, sudo/attach failure, early recorder termination, unknown
records, event count mismatch, helper errors or perf-buffer loss all fail closed.
Per-CPU kernel counters must equal consumed create/submission/failure/completion/
retirement records; positive strace submission counts cannot exceed recorded
requests. The recorder drains only after fresh observations show all tracked
tasks exited and every observed request completed. Untracked SQPOLL tasks or
unmatched completions fail; recording does not stop merely because strace exited.
There is no fallback to syscall-only acceptance. The two Linux CI capability jobs
first record real liburing `CONNECT` in normal/SQPOLL modes and check PID/fd
correlation. Installer controls additionally require normal/SQPOLL `CONNECT` to
be rejected (exit 87, exactly one forbidden opcode), while existing socket and
host-child controls retain exit 86. All control runs are separate from functional
zero-attempt sessions. No runtime, Node, host pin or runtime override is changed.

Whole-app results, including Electron/Chromium traffic and unsupported APIs, remain
report-only artifacts for Studio #15. No Chromium networking flags are changed.

`strace -f --decode-pids=comm,pidns -yy -s 0` follows processes/threads and records only network and
fork/exec, accepted-peer and ring descriptor metadata. With default abbreviation, exec records expose the executable
filename but replace argv with `[...]` and env with a pointer/count. Integration
tests assert argument/environment sentinels never enter raw traces or reports.
Connected FD peers are decoded for inherited sockets sent through the traced
`sendto`, `sendmsg`, and `sendmmsg` calls. Sends through `write()` or `writev()`
on inherited sockets are **not traced**; this is not a claim to cover every socket API. Only sendmmsg destination vectors are unabbreviated; their data
buffers remain suppressed. Unknown peers/vectors fail closed in their process.
Executable paths are used privately for selection and are omitted from JSON;
raw traces are deleted. Terminal records are retained during parsing; missing or
detached tasks cannot be counted as a complete capture. Reported comm names are bounded printable identifiers.
This evidence covers the exercised fixture, not arbitrary configured providers,
installed extensions or proxies.
