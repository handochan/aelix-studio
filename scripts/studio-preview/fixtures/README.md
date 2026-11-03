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
No network addresses are newly exempted: only loopback/Unix IPC is allowed, with
DNS port 53 counted as external even on loopback. Proxy preflight remains strict.

Linux installer acceptance selects the pinned installed host and installed Python,
covering ACP/native children plus independent native helpers. It first verifies
both direct and child TCP/UDP positive controls using that installed Python;
each must produce two attempts, unparsed 0 and exit 86. The zero-attempt functional
run must then exit 0 with observed host roots and unparsed 0. Whole-app results,
including Electron/Chromium traffic, are retained for Studio #15. No Chromium
networking flags are changed. Windows/macOS are functionally tested without an
OS-level zero-attempt claim.

`strace -f --decode-pids=comm,pidns -yy -s 0` follows processes/threads and records only network and
fork/exec metadata. With default abbreviation, exec records expose the executable
filename but replace argv with `[...]` and env with a pointer/count. Integration
tests assert argument/environment sentinels never enter raw traces or reports.
Connected FD peers are decoded so inherited external sockets cannot bypass the
selected gate. Only sendmmsg destination vectors are unabbreviated; their data
buffers remain suppressed. Unknown peers/vectors fail closed in their process.
Executable paths are used privately for selection and are omitted from JSON;
raw traces are deleted. Terminal records are retained during parsing; missing or
detached tasks cannot be counted as a complete capture. Reported comm names are bounded printable identifiers.
This evidence covers the exercised fixture, not arbitrary configured providers,
installed extensions or proxies.
