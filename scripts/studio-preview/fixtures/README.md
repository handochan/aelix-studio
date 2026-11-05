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
An exact `???( <unfinished ...>` register-decoding stub, optionally followed by
`<... ??? resumed>) = ?`, then that task's termination record is retained as a
register hole. The [strace register-read fallback](https://github.com/strace/strace/blob/v7.3/src/syscall.c#L1445-L1466)
does not identify the syscall. Issue #15 decision 6629110086 permits resolving
these records only with complete independent kernel corroboration below. There
must be complete fork ancestry, no pending fork/exec and no subsequent known
syscall or post-termination record. With kernel evidence, signal notifications
and normal exit delimiters may accompany the exact register stub; they confer
no exemption themselves. Without corroboration, the records remain blocking
records in selected-tree and whole-command enforcement alike.
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

The **same capture** first selects a verified point before the tracer's register
read. Where available, `syscall_trace_enter` runs before ptrace/seccomp. Its BTF
signature must accept `struct pt_regs *regs`; the native
x64 `orig_ax`/`di` or arm64 `syscallno`/`orig_x0` layout supplies the syscall/fd.
It numbers **all** invocations per TID and records network/write invocations
before any tracer register read. Native syscall numbers come from Linux's
[x64 syscall table](https://github.com/torvalds/linux/blob/v6.8/arch/x86/entry/syscalls/syscall_64.tbl)
and [arm64 generic ABI](https://github.com/torvalds/linux/blob/v6.8/include/uapi/asm-generic/unistd.h).
Kernel-read failure, ABI incompatibility, signature or function absence fails.
Both the pre-entry hook and the post-seccomp raw entry reject non-native ABIs.

Linux 7 x64 [inlines this helper](https://github.com/torvalds/linux/blob/v7.0/include/linux/entry-common.h#L81-L115).
There the required alternative is `ptrace_notify` with **both** syscall-entry
message 1 and syscall-stop signal 133 (SIGTRAP|0x80), before
[ptrace_stop and any tracer register read](https://github.com/torvalds/linux/blob/v7.0/kernel/signal.c#L2514-L2525).
The saved register address follows Linux's own
[task_pt_regs macro](https://github.com/torvalds/linux/blob/v7.0/arch/x86/include/asm/processor.h#L648-L652).
Only native x64 kernels 6.8–7.0 with readable running-kernel config and VMAP_STACK
are supported for this alternative. The config hash is retained. PAGE_SIZE must
be 4096; THREAD_SIZE is PAGE_SIZE<<(2+CONFIG_KASAN), and the top padding is 16
with CONFIG_X86_FRED, zero otherwise. BTF supplies register/field sizes. Every
entry checks that the actual stack VM area's address equals task.stack and its
page count equals the derived size; any disagreement fails. Missing config,
probe, BTF signature or an unsupported layout never falls back to guessing.
Function contracts are decoded from live BTF FUNC/FUNC_PROTO types (pointer
targets and integer width/signedness), rather than formatted `kfunc -lv`
argument names or fentry availability. The complete BTF hash and signature
hashes are retained. The report retains `preEntryProbe` and signature provenance. ARM's direct
register-pointer path and the common P/N/socket correlation rules are unchanged.

It also requires `raw_syscalls:sys_enter` and `raw_syscalls:sys_exit`, decoding
the native kernel ID, first argument (fd), and result for `connect`, `sendto`,
`sendmsg`, `sendmmsg`, `write`, `writev`, `accept` and `accept4`. It does not rely
on per-syscall named events: the Azure measurements exposed socket writes with
no corresponding named write event. Raw argument-array/ID/result fields are
mandatory, and entry/return IDs must agree. Other calls retain only an active
kernel ID for unmatched-operation diagnostics, never argument buffers. This
`nativeSyscall` is the current kernel event, not a cached strace annotation.
Generic WRITE/WRITEV is not automatically a network operation. Required
`vfs_write`/`vfs_writev` probes observe the actual referenced file, not an
entry-time fd-table lookup. An orphan write may be classified non-network only
with real VFS observations for that same TID/ordinal/WRITE epoch, all observed
files REG/FIFO or individually proven eventfd, and no socket operation. Mode-0
eventfd observations require `eventfd_write` for the **same file object**. Socket,
unsupported mode, missing file evidence, invalid context or any loss stays fatal.
File identity is BPF-private; reports contain no kernel addresses. These proofs
are separate `kernelNonNetworkWrites`/`kernelNonNetworkWriteInvocations`, and do
not bypass the FD-lifecycle guard or infer non-network from return values.
The same recorder also attaches
required concrete kprobes `kernel_connect`,
`sock_write_iter`, `sock_sendmsg`, `tcp_v4_connect`, `tcp_v6_connect`,
`udp_sendmsg`, `udpv6_sendmsg`, `inet_sendmsg`, `inet6_sendmsg`,
`__ip4_datagram_connect` and `__ip6_datagram_connect`.
Attachment/fields/BTF/privilege failures are fatal. These work jointly with P/N
and the io_uring opcode policy: direct attempts remain recorded even when LSM
denies execution; normal/async socket WRITEV goes through `sock_write_iter`;
kernel sends use `sock_sendmsg`; IP send dispatch and TCP/UDP protocol functions
cover direct send syscalls that bypass public `sock_sendmsg`. Unmatched concrete
operations are fatal. The raw entry additionally rejects compatibility ABIs
whose syscall multiplexers are outside this native 64-bit policy. It never reads
registers through ptrace. Running-kernel BTF supplies task/socket layouts.

Why both layers: Linux [syscall entry ordering](https://github.com/torvalds/linux/blob/v6.8/kernel/entry/common.c#L43-L61)
puts syscall tracepoints **after** ptrace and seccomp; their absence alone does
not identify an interrupted call. Linux [socket write dispatch](https://github.com/torvalds/linux/blob/v6.8/net/socket.c#L1143-L1161)
and [message dispatch](https://github.com/torvalds/linux/blob/v6.8/net/socket.c#L740-L769)
reach the socket security/protocol layer; [io_uring send](https://github.com/torvalds/linux/blob/v6.8/io_uring/net.c#L414)
also reaches it. The protocol probes provide an additional independent check. See the concrete
[VFS socket write](https://github.com/torvalds/linux/blob/v7.0/net/socket.c#L1175-L1195),
[IP send dispatch](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/af_inet.c#L858) paths.
Direct CONNECT attempts are accounted for by P/N even when LSM or address
validation prevents protocol execution. TCP protocol hooks and internal IPv4/IPv6
datagram connect functions observe execution; `kernel_connect` observes kernel
helpers. The internal datagram hooks include Linux 7's UDP wrappers, which
bypass the public `ip4_datagram_connect`/`ip6_datagram_connect` wrappers
([IPv4](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/udp.c#L2196-L2202),
[IPv6](https://github.com/torvalds/linux/blob/v7.0/net/ipv6/udp.c#L1307-L1313)).
AF_UNSPEC disconnect exits the generic datagram dispatcher without starting
protocol connect or transmitting payload; its known P/N invocation remains
recorded. No request-family or arbitrary file-private-data adapter is used.
Families come from the actual socket's `sk.__sk_common.skc_family`, including
the typed VFS write callback. Zero/unsupported families and IP operations
without a decoded or FD-lifecycle-derived destination fail classification.
LSM permission checks are not used as operation identity. Supplemental kallsyms
same-address alias groups can diagnose optimized permission wrappers; they
never exempt an operation and contain public names, not kernel addresses.
A receive-only AF_UNIX regression checks that receiving data is not invented
as a send operation. No family/time/unknown-record matching is relaxed.
Only metadata is recorded: monotonic timestamps, normalized TID/TGID, syscall,
per-thread ordinal, fd, result and socket family; no buffers/argv/paths. The
recorder's stopped root is strace itself; its own output writes are outside the
audited command, while all descendants remain tracked without CPU restrictions.

Kernel network event totals and task-exit totals must equal consumed records.
Each strace TID needs a unique kernel identity and complete birth-to-exit range
in the auditor's PID namespace, with matching kernel/normalized TGID. Extra userspace descendants of a known tracee fail. The tracer's own
capability-probe siblings are distinguished only by verified fork topology;
any unmatched networking there still fails globally. io-wq/SQPOLL workers
require kernel-set IO/USER flags, complete creator ancestry and an owned ring.
A required `create_io_thread` entry/return probe records them **before wakeup**,
including io-wq retries scheduled back to the owner with task_work. Ordinary
`sched_process_fork` alone does not cover this copy_process path. Birth/exit
records, BTF return signature and consumed worker counters must agree. See
[worker creation](https://github.com/torvalds/linux/blob/v6.8/kernel/fork.c#L2836-L2850)
and [owner-context retry](https://github.com/torvalds/linux/blob/v6.8/io_uring/io-wq.c#L362-L386). Worker names confer no permission.
Independent creation-entry/return counters (including error returns) must
balance; duplicate outstanding entries fail. This detects missed kretprobe
returns, which can occur independently of perf-buffer loss
([kernel kretprobe limits](https://docs.kernel.org/trace/kprobes.html#how-does-a-return-probe-work)).
Every **pre-entry invocation** must match the ordered decoded call/fd, including
failed and emulated-success calls, without skips. Post-seccomp entries/returns
and socket hooks must map to that same per-TID invocation ordinal. A successful
strace result alone does **not** prove execution: seccomp ERRNO(0), user
notification or SIGSYS emulation may fake success. The separate pre-entry
prevents an emulated decoded call from substituting for a hidden executed call.
Missing returns for executed decoded calls,
unmatched socket operations (including asynchronous writes), missing lifetimes,
identity reuse, namespace mismatch, counter disagreement and any loss fail.
Already-fatal UDP/io_uring classifications retain additional socket evidence as
`kernelCorroboration` on the existing issue; this preserves control counts and
never qualifies a hole for resolution.

A no-network kernel proof cannot rule out an unseen FD mutation. Candidate
register intervals overlapping any possibly live UDP socket invalidate its
association exemption and keep the register hole unresolved. This includes a
socket duplicated before its later connect. Socket creation starts possible
lifetime at entry; close/close_range/dup replacement/exec cannot prove removal
before their **completion** record, including joined unfinished calls. Closed
before the interval remains distinct from a pending close. The guard preserves
shared/inherited tables and reports `udp_lifetime_unparsed_register`; it never
guesses that an unknown syscall left FD ownership unchanged.
Successful UDP-labeled dup/F_DUPFD calls whose source is missing from the
ledger also fail. A pending close cannot silently discard that known alias;
possibly affected associations remain invalid with unbounded uncertain lifetime.

Only a TID with no unmatched kernel activity over its **entire** verified
lifetime may discharge the exact terminal register holes. This proves absence
of missed network execution, without guessing that the unknown syscall was
non-network or using a cached syscall number. `kernelResolvedRecords` and
`kernelResolutions` separately retain each normalized/kernel TID, record count,
monotonic range, pre-entry/execution/socket-event counts and fixed proof code.
An otherwise-unmatched **final** pre-entry can prove nonexecution only when its
ordinal equals the TID's final all-syscall ordinal and it has no post-entry or
socket hook. `notExecutedOrdinals` records this additional proof separately.
A final pre-entry may also have been killed before strace printed a `???` stub;
`kernelNotExecutedInvocations`/`kernelNotExecuted` record these proven unexecuted
invocations separately with TID, range, syscall, fd and ordinal. They require a
known terminated strace TID and never subtract any unrelated unparsed record.
Known calls with an unreadable/missing return field retain their decoded call
and fd in the same ordered invocation matching. `kernelResultFields` and
`kernelResolvedResultFields` report only that single missing field recovered
from an exact raw exit, proven final nonexecution, or an actual VFS non-socket
write. Unknown/missing destination fields, ambiguous ownership, UDP writes and
FD-lifecycle errors remain blocking. Pending descriptor/fork/exec calls are
never recovered by this rule. Overlapping raw syscall states remain failed and
include bounded numeric old/new syscall metadata for diagnosis.
Every other unknown strace record remains fatal. App and host/native reports
use this one implementation and the same `sourceSha256` policy inventory.
Each task's residual `unparsedRecordKinds` records fixed reason codes and
allowlisted syscall names with counts. It contains no trace text, FD annotation,
path, argv or buffer. Independent register/result proofs remove their own keyed
counts; this diagnostic never exempts or resolves a record by itself.
Pre-entry mismatches remain fatal. Their `kernel_pre_entry_mismatch` record
retains only timestamp, kernel/namespace TID, ordinal, decoded old/new call and
executed syscall number so a failed capture can be investigated without raw
registers, paths, payloads or kernel pointers.
`externalOperationDiagnostics` preserves numeric TID/sequence/FD, fixed socket
kind and kernel hook names, families and file modes, plus associated UDP writes.
It contains no FD labels, paths, buffers or kernel pointers and never changes
classification. This distinguishes an actual write from an association-only
probe when investigating a failed gate.

### UDP socket-object proof (Issue #15 decision 6647325683)

`udpConnectOnly` (D) is counted per interpreted IP `connect`, using kernel socket
objects, never an FD-number lifecycle. Mandatory `sk_alloc` entry/return establishes
an allocation generation; `udp_init_sock`/`udpv6_init_sock` binds it only after
checking IP family, datagram type 2 and UDP protocol 17. UDP-Lite also calls these
initializers and is unsupported, never silently treated as UDP. Objects created
before collection are ineligible. Reuse of a freed address creates a new generation.

`inet_dgram_connect` records one outer IPv4/IPv6 datagram invocation. Each D needs
exactly one object connect matching the same kernel/namespace TID, raw syscall
ordinal and entry/return interval, themselves matched in order to the strace record.
Missing or duplicate matches fail. `udp_sendmsg`/`udpv6_sendmsg` record protocol sends
from any task using the watched object. Global `ip_local_out`/`ip6_local_out` and `ip_send_skb`/`ip6_send_skb` hooks
also block D for cork flush and kernel/tunnel output using that socket. The
wrapper can be inlined into `ip_send_skb` (observed on local7.0.11), so its
out-of-line symbol alone is insufficient. Both lower skb-output hooks are
mandatory too, and actual IPv4/IPv6 loopback controls must observe protocol
and IP-output events before the auditor qualifies them. Neither
FD inheritance, dup, exec flags, untraced FIONCLEX, SCM_RIGHTS nor pidfd_getfd can
hide a send or prove a release. `receive_fd` (file arg0), `receive_fd_replace`
(file arg1) and final socket-file release record additional users. FD imports must
be socket-mode files and not O_PATH handles before private data is read.

D additionally requires zero sends over that entire generation, a final
`__sk_destruct` entry AND return before collection ends, complete loss-free
collection and verified namespace/task attribution. `sk_free` is not sufficient:
TX references, workqueues and RCU can defer the actual free. The final callback is
watched globally and need not run in a lineage task; its executor is not counted
as a socket user. Entry saves the old generation per nested callback; return does
not dereference freed memory or erase a newer allocation at the same address.
Watched-address destructor frames and UDP allocation/destruction counters must
balance. The fexit original `head` pointer is used only as a scalar key, never
dereferenced after free. A per-(task,address) stack includes a nested reuse even
when the new object is not UDP, so that return cannot pop the older generation.
Unrelated TCP destruction creates no watched frame and cannot be cut into a UDP
collection error at detach. Missing watched entry/return still fails through
object/counter checks and retained program recursion statistics. The drain waits for tasks, requests and UDP object frees, rather than
stopping when strace returns. Opaque object IDs, connect ranges, sender/user PIDs
and final destructor times are retained in `udpSocketObjects`; raw pointers are not.

For host/native scope, an object used by selected and unselected processes fails
with `udp_socket_cross_scope`. Unknown external users or namespace mismatch fail
rather than being attributed to a guessed owner. IPv6-to-IPv4 family mutation
within one generation is currently unsupported and fails conservatively.

Complete object proof can replace only the UDP-specific FD-order, unknown-close,
CLOEXEC and ring-target uncertainty rules. Every UDP connect predicted by that
ledger or labelled UDP in strace must also have exactly one kernel-object match.
A reconciled kernel TCP protocol hook overrides a contradictory FD-only UDP
prediction: that key is never required as UDP and is never given D. It remains
an ordinary TCP attempt. Missing object proof still retains conservative failure.
Without this proof, the old conservative UDP failures remain and D is never
awarded. TCP labels/protocol hooks always veto D. The existing ring FD ledger,
explicit opcode allowlist, CONNECT rejection and independent syscall reconciliation
remain blocking; object proof never exempts unknown ring operations. A UDP io_uring
WRITEV that reaches the protocol still returns87 (1/1/1), and its worker ownership
must be proved. File WRITEV/CLOSE can no longer taint an unrelated, proven closed
unsent object solely because the target FD is absent from the ring tracepoint.

Linux source basis (checked 6.8 and7.0; running BTF and attachability required):

- [Allocation, RCU and final destructor](https://github.com/torvalds/linux/blob/v7.0/net/core/sock.c#L2296-L2435),
  [protocol initialization order](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/af_inet.c#L334-L394),
  [datagram connect](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/af_inet.c#L576-L600).
- [UDP send/cork](https://github.com/torvalds/linux/blob/v7.0/net/ipv4/udp.c),
  [IPv6 and mapped-IPv4 send](https://github.com/torvalds/linux/blob/v7.0/net/ipv6/udp.c),
  [splice via MSG_SPLICE_PAGES](https://github.com/torvalds/linux/blob/v7.0/fs/splice.c#L795-L884),
  [io_uring send](https://github.com/torvalds/linux/blob/v7.0/io_uring/net.c).
- [FD receive](https://github.com/torvalds/linux/blob/v7.0/fs/file.c#L1387-L1420),
  [O_PATH mode](https://github.com/torvalds/linux/blob/v7.0/include/linux/fs.h),
  [socket files](https://github.com/torvalds/linux/blob/v7.0/net/socket.c).
- [Exit ordering](https://github.com/torvalds/linux/blob/v7.0/kernel/exit.c#L947-L1019):
  `sched_process_exit` precedes `exit_files`/`exit_task_work`. It supplies immutable
  namespace identity, while required `do_task_dead` supplies the final task range.
  Announcement/final-event counters must match every tracked task. Late namespace
  lookup is unsafe after reaping, so cached identity is checked against current
  kernel TID/TGID. The pre-ptrace version support in `entry.py` is unchanged.

All active network/task/ring recording now uses public BTF fentry/fexit or raw
tracepoints. There are **34 TRACING programs** (17 object/task plus 17 network/
pre-entry/worker hooks), **9 RAW_TRACEPOINT programs** and the existing single
interval sampler. Classic TP/kprobe programs are not allowed in the active
recorder receipt. BEGIN/END are setup/teardown triggers outside that active set.

This removes the CPU-global `bpf_prog_active` guard shared by classic TP/kprobe
programs: different nested probes can otherwise suppress one another before
PID filtering. The observed failures named `sys_enter`, `sys_exit`, VFS/eventfd
and the syscall-entry probe while all UDP typed programs had zero misses.
Raw TP and trampoline programs use their own recursion contexts. Every nonzero
program miss remains fatal; nothing is subtracted or waived. The interval
sampler remains a perf-event program and is also strictly checked.

Every owned BPF program FD is retained with `BPF_PROG_GET_FD_BY_ID` before stopping
the recorder; after detach its fdinfo must expose an explicit zero
`recursion_misses`. The source declaration graph and retained program types must
match 34/9/1 exactly. Missing fields/references, an unexpected classic provider or
nonzero miss fails D. `udpSocketObjects.lossChecks` retains the coverage receipt.
`programLoss` preserves every offending ID, type, generated name when readable,
and count. `stage=after-detach` is the snapshot time, not when the miss occurred.

BTF requests still read their file on every validation. Only decoding identical
byte content is cached (one entry); public signature results are fresh values.
Changed/unreadable data is never served from a path cache. Forty signature
results were identical before/after this optimization; one local benchmark
changed 2.620s→0.140s. The real positive unit uses the same 60s envelope as the
production positive controls; exact detection/exit and loss assertions remain.

Raw arguments are separately checked using each running kernel BTF
`btf_trace_<event>` TYPEDEF→PTR→FUNC_PROTO. Exactly one validated hidden ptr:void
data argument is removed, then only known 6.8/7.0 raw prototypes are accepted.
The `/format` payload is still checked and hashed but is not treated as raw ABI.
`sys_enter` supplies regs+NR; `sys_exit` supplies regs+return, with NR recovered
using the kernel's native syscall_get_nr fields (x64 orig_ax, ARM syscallno).
First FD uses x64 di/ARM orig_x0. These are live kernel tracepoint arguments,
independent of strace's register read. The pre-ptrace observation is a typed
fentry at the same verified function, with x64 notify exit_code/message guard.
The existing native ABI checks and pre-ptrace kernel-version boundary remain.

io_uring create uses raw FD arg0/ctx arg1/flags arg4. Submission reads the live request;
failed opcode comes from SQE arg0, never an assumed request opcode. Completion
copies only ctx arg0/req arg1 scalar values and never reads a dead request. Both
known completion prototypes are validated; unknown argument shapes fail.

Source: [classic shared guard](https://github.com/torvalds/linux/blob/v6.8/kernel/trace/bpf_trace.c#L111-L152),
[raw per-program recursion](https://github.com/torvalds/linux/blob/v7.0/kernel/trace/bpf_trace.c#L2073-L2095),
[trampoline misses](https://github.com/torvalds/linux/blob/v7.0/kernel/bpf/trampoline.c#L1143-L1156),
[fdinfo counter](https://github.com/torvalds/linux/blob/v6.8/kernel/bpf/syscall.c#L2230-L2284),
[raw BTF declarations](https://github.com/torvalds/linux/blob/v7.0/include/trace/bpf_probe.h),
[io_uring prototypes](https://github.com/torvalds/linux/blob/v7.0/include/trace/events/io_uring.h),
[bpftrace raw/typed probes](https://bpftrace.org/docs/0.21).

Missing symbols, inline-only functions, BTF/signature/layout mismatch, failed map
updates, unmatched callback returns and event loss fail collection. The BTF member
reader follows anonymous unions and requires duplicate struct definitions to agree
on size and offset; offsets are never guessed. `sk_prot_free` is inlined on the
measured local kernel, so the final destructor return is the required boundary.
No destination-name/address exception, CPU restriction or ignored failure is used.

The raw backend requires the reviewed bpftrace 0.20.2; other versions fail.
Version 0.17.0 does not implement this raw provider and is not a fallback. BEGIN runs before attachment, but its printf is not consumed until both
attachment loops succeed and poll_output starts. Thus observing READY in the
broker is an attachment-complete barrier for this version. See
[bpftrace 0.20.2 run](https://github.com/bpftrace/bpftrace/blob/v0.20.2/src/bpftrace.cpp#L1237-L1375)

`--transport-controls` keeps the original UDP results 0/86/86/87/87 and adds real
FIONCLEX+exec exit/send (0/86), SCM_RIGHTS send (86) and pidfd_getfd send (86). IPv4/IPv6 loopback sends must receive the test datagram,
record both protocol and IP-output layers, and return 0 with D=0.
Real retention controls also require 87 for an FD received from a pre-collection
creator, and an object retained by an outside holder beyond collection end.
The former must fail specifically for missing birth with complete collection;
the latter must show balanced tasks/requests and an unfreed UDP object in the
failed drain. Synthetic controls additionally cover ambiguous correspondence,
address reuse, event loss and cross-scope users. Pure FD-only
unit traces can no longer establish D. Original direct/child/host controls remain 86
and normal/SQPOLL CONNECT remain 87.

`close(decimalFD<optional annotation>) = ?` retains a known entry with an unknown
return. Only a terminated task with complete kernel reconciliation and no unmatched
network action may account for that field. `kernelMetadataResolutions` retains TID,
range, sequence and FD with `returnValueKnown=false` and `fdClosureInferred=false`.
It never proves FD closure. UDP descriptor uncertainty can be superseded only by
the complete object proof above; ring descriptor uncertainty remains blocking.
Numeric close/dup/fcntl transitions and standalone `unshare(CLONE_FILES)` feed
the ring ledger even without an FD annotation. This retains unlabelled aliases,
CLOEXEC changes and independently unshared tables. Generic mappings are ignored
only for decoded numeric descriptors outside that ledger; borrowed ring mappings
remain unsupported. `dup2(fd, fd)` retains its original CLOEXEC state.
Partial close arguments, missing entries and other FD mutations stay fatal.
Synthetic controls exercise hidden network activity, no network execution,
seccomp ambiguity, loss, missing identity/range/return, and missing attachments;
actual installed-app shutdown races provide additional real-trace coverage
when they occur. A deterministic signal race cannot guarantee a strace register
read failure, so passing synthetic controls does not claim a real race occurred.
The fifth transport control, `uring-async-writev`, forces `IOSQE_ASYNC` and
requires a real pre-wakeup worker birth, balanced creation counters and complete
worker exit. It retains the WRITEV rejection (87, external/unparsed/classification
1/1/1), while the original four transport control results remain unchanged.

An ordinary new TCP/UDP client socket must establish its peer through traced `connect`,
or a rejected ring `CONNECT`, before connected `READV`/`WRITEV` can send data.
Server-side connections can instead originate in `accept`/`accept4`, so these are
also traced: non-loopback or unresolved accepted peers fail selected-tree
qualification. Unconnected UDP vectored writes cannot choose a peer; destination
selecting `SEND*` ring operations are rejected. Previously connected inherited or
SCM-passed sockets and protocol-specific connections such as SCTP connectx retain
the S3 limitations below. Allowed file operations do not
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

Within these scoped host/native sessions, the separate whole-command report
remains diagnostic. Studio #15 separately enforces the whole installed app with
this same auditor and no executable-root selection.

`strace -f --decode-pids=comm,pidns -yy -s 0` follows processes/threads and records only network and
fork/exec, accepted-peer and ring descriptor metadata. With default abbreviation, exec records expose the executable
filename but replace argv with `[...]` and env with a pointer/count. Integration
tests assert argument/environment sentinels never enter raw traces or reports.
Connected FD peers are decoded for inherited sockets sent through `sendto`,
`sendmsg`, `sendmmsg`, `write` and `writev`. These calls are all traced; UDP object
send/output hooks also catch paths such as splice and io_uring. Protocol-specific connection APIs such as
`setsockopt(IPPROTO_SCTP, SCTP_SOCKOPT_CONNECTX)` are also **not traced**; this is not
a claim to cover every socket API. Only sendmmsg destination vectors are unabbreviated; their data
buffers remain suppressed. Unknown peers/vectors fail closed in their process.
Executable paths are used privately for selection and are omitted from JSON;
raw traces are deleted. Terminal records are retained during parsing; missing or
detached tasks cannot be counted as a complete capture. Reported comm names are bounded printable identifiers.
This evidence covers the exercised fixture, not arbitrary configured providers,
installed extensions or proxies.

## Shared Studio #15 transport policy

The app-wide blocking gate now invokes this same auditor without selecting roots.
The scoped host/native gate keeps its scope and blocking behavior. UDP connect
associations are counted separately only with the complete kernel socket-object
proof above. TCP connects and UDP sends remain attempts, including failed calls.
No destination-name/address exemption is used. See
[the app gate](../../outbound-audit/README.md) for commands and controls.
