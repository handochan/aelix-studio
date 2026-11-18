# Immutable Studio host release

Managed runtime entrypoints force `PYTHONDONTWRITEBYTECODE=1` to protect the installed bundle.
Agent shell tools and the user-project `python`/`pytest` commands they launch inherit this setting too: implicit `.pyc` caches are not written, so cold imports may be slower.
This performance tradeoff is intentional; the Windows module-path bootstrap remains scoped separately to the owned native interpreter.

`default.json` pins `host-v0.2.2-aelix.4`, its source commit/tree, five archive
SHA-256 values and release provenance. `provenance.json` is the byte-preserved
published release asset. The release also publishes `aelix-studio-host-checksums.txt`;
its archive digests are pinned in `default.json`. The source archive/build/patch flow is retired.

`prepare.cjs` verifies each archive before extraction, checks the released binary,
retains LICENSE/NOTICE and the original build receipt, then asks the released host
to prepare managed Node resources at build time. Studio records a complete resource
inventory. Launchers verify release provenance, target, receipt, code identity,
license/notice and the managed-resource contract. The Linux receipt uses `GLIBC_2.30`;
Mach-O identity normalizes bounded installer signing metadata while retaining code.
The host identity recipe hash is recorded by the host, not compared against a
Studio script whose docstring differs.

`smoke.py` / `probes/smoke.mjs` exercise the actual installed app and released host with
synthetic native model/tool effects: Ask deny/allow, Yolo and guardrail enforcement,
Stop, a Yolo→Ask failure under the `fail-start` marker, and full app/host
restarts in both modes. A transparent native stdio relay closes the real
`permissions/set` downgrade after ACP saves Ask and before native receives it;
it also rejects worker startup while the marker is present. No policy replies
are synthesized. After clearing the fault and fully restarting, the installed
host must restore Ask, require actual consent, persist the corrected selection,
and continue to permit a later explicit Yolo selection.
No Studio permission-restore patch or backend override is used. The old forwarding
harness and migration 044 are removed; see `docs/studio-preview/README.md` for the
internal test database reset and phase-two acceptance scope.

The #51 launch failure's root cause remains **unconfirmed**. PR #45 observed the
third Linux main process exit with code 0 and no signal before identity
evaluation. The new smoke launches exactly once: a clean spontaneous exit still
fails. `closeElectron` waits for the previous OS main process to terminate,
including Playwright's target-closed path, to test the shutdown-race hypothesis
without masking a product startup failure. Every existing UI/effect assertion
and timeout is retained.

Each launch records its sequence, start/exit-observation/close-request times,
exit code/signal, whether exit preceded smoke shutdown, main output, and a
best-effort list of sandbox-matched process IDs before startup. The existing
uploaded `renderer-result.json` includes these records even on failure, so no
workflow path/gate change is needed. `startup-lifecycle.jsonl` is also retained
for whole-app audits. A failed launch prints one `Studio launch #N FAILED` line
with natural-exit/code/signal/time. `DEBUG=pw:browser` captures process output
from the start in the job log; bounded main output is also retained after the
Playwright process handle becomes available. These diagnostics use separate
fields from PR #45's `main-launch-*` logs.

The #59 diagnostic additions preserve all original checks, timeouts and the
single-launch behavior. `electron-main-exit` wait rows now include `launch`,
`pid`, `phase`, start/end timestamps and the unchanged 20,000ms bound. The phase
distinguishes `identity-failure-exit-observation` from normal
`cleanup-main-exit` and `identity-failure-cleanup`. Already exited processes
produce an `alreadyExited` observation without a new wait. Each launch retains
these rows in `mainLaunches[].waits` in `renderer-result.json`.

`mainLaunches[].identityFailedAt` and `.identityProtocol` are written before
the existing failure-observation wait. `.protocol` retains ongoing diagnostics.
An in-process observer wraps the installed Playwright 1.58.2 protocol logger
before CRSession discards CDP error codes or changes their message. It adds no
connection, protocol command, DEBUG setting, retry or driver patch. The factory
is restored after launch; the existing connections' observers retire at cleanup.
Context IDs/default flags, request IDs, fixed method names and error codes are
retained. Fixed CDP/V8 inspector messages (including `Promise was collected`)
are preserved only on exact equality, using the pinned Electron 37.10.3 /
V8 13.8.258.32 source literals cited in the observer. Prefixes, suffixes and
unrecognized messages remain fully redacted. Only message length, whitespace
word count, Unicode decimal-digit presence and `/`/`:`/`=` presence are retained
as shape information. Evaluation errors also retain the request's `awaitPromise`
and `returnByValue` booleans (null when absent or not boolean), without copying
other parameters. Error data, names, origins, URLs, evaluation contents, session IDs,
paths and tokens are never copied into this new protocol evidence. The observer
keeps 64 events, 8 errors and 16 preceding context events per error; the identity
snapshot is frozen before later cleanup events. An unsupported adapter is
recorded as unavailable without changing the smoke result.

`renderer-result.json.processTimeline` (`aelix.launch-process-timeline/1`)
samples once per second, with no overlapping query and no product process signaling or
exit wait. Linux uses `/proc` without spawning polling subprocesses; macOS uses
asynchronous ps and Windows uses CIM. Query failures are unavailable observations,
never invented exits. Only owned/sandbox-matched main, host, ACP, native-wrapper
and native generations are retained, using fixed role labels and numeric
PID/parent IDs. Linux start ticks, Windows creation ticks and macOS ps lstart
(second precision) distinguish generations. Executable/argv data is classified
privately and discarded. First/last observation, reparenting, live-sample lower
bounds and first observed absence/zombie are retained, up to 512 generations.
`roleEvidence` identifies fixture-argv inference; it is not an executable audit.

Sample start/completion timestamps and phases/launch numbers bound in-flight
queries spanning a launch transition. `exitObservedAt` is an observation bound,
not a precise OS exit timestamp. Its live lower bound is
`lastLiveSampleStartedAt`, or unknown if no live sample was seen (including CIM's
unknown state). Short-lived processes can fall between samples. Main handle exit
events remain in `mainLaunches` with their original direct observations.
The process timeline is also appended to `startup-lifecycle.jsonl`; the complete
summary is merged into the already uploaded renderer result on both installer
and whole-app jobs. No artifact path or workflow change is required.

Linux collection keeps the 1s stat/liveness cadence, but uses one small synchronous
proc batch instead of hundreds of asynchronous reads and libuv/eventfd callbacks.
Sanitized cmdline classification is cached by PID/start ticks. New generations,
changed comm values and known owned actors/root descendants are reclassified;
owned actors can exec another Python role without changing start ticks. Launch,
identity-success/failure, close-requested/main-exit/after-close and cleanup checkpoints
also refresh all candidate classifications. Raw argv/executable paths are never
cached or exported. This reduces periodic collection work without adding a
polling process or changing audit hooks.
Sampling is paused from launch resolution until the identity evaluation settles,
including already queued batch microtasks and timer ticks. Before-launch capture
is retained, and an after-identity or identity-failed checkpoint requests a fresh
process table on the next available sampler turn. An older asynchronous query completing in
that window is discarded. No product wait is added. Short-lived processes inside
this intentional observation gap can be missed; main handle/protocol evidence
still records the identity result and its start/end timestamps. Sample timestamps
refer to actual collection start, rather than the time its microtask was queued.
Batch entry yields through `setImmediate` before checking the identity guard so
an already resolved launch also reaches its await continuation first.
`process-timeline-checkpoint` journal markers retain the request phase, launch
and `requestedAt` even if cleanup reaches another phase before collection runs.
They are requests, not samples; actual rows keep their collection start and
completion phases. Thus a failed identity checkpoint is retained without
delaying cleanup or relabeling an after-close sample as an earlier observation.

Full renderer summaries are persisted at most every 5s while unchanged, and
immediately for structural process changes and checkpoints. Liveness observations
still update internally each second; an exit delta includes the latest live
lower bound. The JSONL contains `process-timeline-delta` events with only changed
generations, or checkpoint/unavailable metadata. A periodic summary refresh has
no JSONL event. All renderer-result writes (including config/recovery and final
results) use a sibling temp file plus rename, so readers see complete JSON.
Delegation evidence also merges the existing timeline through this writer.
Windows EPERM on replacement gets at most two 10ms retries; all lifecycle sink
exceptions are isolated from the smoke outcome. These are diagnostic file-write
retries, not app retries. This is atomic visibility, not a new power-loss durability claim. Existing smoke
assertions, timeouts, retry policy and diagnostic exception isolation remain.

Windows reuses one hidden, diagnostic-only PowerShell CIM reader. A cold query
still has the same 2s observation bound and can be unavailable; a late response
is discarded and the warmed reader serves subsequent periodic samples. No app
wait or retry is added. `unavailableReasons` counts only fixed, privacy-safe
reason codes. Stopping the sampler terminates only its directly owned diagnostic
worker handle, never a product/host/ACP/native process. This avoids repeatedly
paying PowerShell startup within every 2s query. The earlier short-lived query
implementation produced 53/53 unavailable observations on Windows CI while the
installed smoke itself passed; that was a diagnostic failure, not successful
process evidence. The old pre-launch sandbox check remains unchanged.

Provider helper smoke's old 5s callback guard came from fixture commit
`382c819db`, not a product response requirement. Product service limits remain
20s for ordinary requests and 180s for login. Fixture callbacks now use 20s:
the observed slow darwin-x64 runner needed ~4.8s just for each cold helper start,
and PR #45's additional imports reduce that margin further. The outer helper
suite hang guard is 300s instead of 120s (~31 starts × 4.8s ≈ 149s). Every
request/frame/process-exit wait logs elapsed time and its bound; timers clear on
settlement. Helper (300s maximum) and host (240s maximum) now share 450s, inside
the existing 480s capture bound with attachment/receipt margin. A slow helper
therefore reduces the host phase's remaining budget. Assertions and product deadlines are unchanged, and hung helpers
still fail and are stopped by the owned fixture cleanup.

The stdout markers, log/data/DB names, bootstrap secret and `AIONUI_*` interfaces
remain unchanged. Only the executable and release-archive identity have changed.

## Updating the release pin

With dependencies installed and an authenticated `gh`, run:

```sh
node scripts/studio-preview/host-release/pin.cjs host-v0.2.2-aelix.4
```

The generator requires an exact published immutable stable release, verifies asset
API digests against the checksum file, checks provenance against the tag's commit
and tree, and requires all five target smokes. It generates `default.json`, the
byte-preserved `provenance.json`, `baseline.json` (including the SHA-256 of the
formatted source manifest), and `package.json`'s `aioncoreVersion`. It computes all
outputs before replacing files. Normal runtime preparation still verifies archive,
binary and receipt bytes. A pin change requires fresh resource/runtime preparation,
installer builds, and all acceptance tests; old `.local` outputs must not be reused.

Phase two initially tested aelix.3 and now pins the final aelix.4 release from
host #7 / PR #19. Native and ACP exact pins are unchanged. Every pin change is
qualified with fresh owned outputs; previous runtime/payload/resources are archived.
The Linux acceptance gate is zero external attempts and zero unparsed records
inside the host and installed-native descendant trees, with detected direct/child
positive controls. The whole app is reported separately for Studio #15; Chromium
policy is unchanged. See the [audit contract](../fixtures/README.md).

## Host environment

Settings come from the build operator's / launching process's environment, with
no Studio preference or implicit runtime opt-in:

- Build: set `AELIX_STUDIO_HOST_NODE_MIRROR` explicitly (CI uses
  `https://nodejs.org/dist/`). The released host verifies its pinned Node archive
  hashes. Missing settings do not enable a public fallback.
- Runtime: the shared desktop/WebUI launcher forwards
  `AELIX_STUDIO_HOST_NPM_REGISTRY` and `AELIX_STUDIO_HOST_REMOTE_IMAGES` unchanged.
  Omit both to retain host defaults. A registry is an HTTP(S) mirror URL; exactly
  `REMOTE_IMAGES=1` opts into the existing host image validation. Restart after
  changing launch settings. These environment settings are not renderer settings.
- User-installed npm/npx agents/MCP remain explicit user configuration; a mirror
  does not sandbox arbitrary extension code.

Remote preview images never fall back to a direct renderer request. Disabled
images and other failures have distinct localized explanations. ACP application
errors preserve `protocol_code` and opaque camelCase `data`; the four new error
codes provide guidance without replay/reconnect actions. MCP warning reasons and
`supersedes_key` survive both live display and history reload.

The default Hub preparation paths (`dist-latest`, and the packaging workflow's
`dist-ebc6a2b`) were inspected on 2026-11-03: their seven/four ZIPs contain no npx
agent launch or npx installation command. Several contain bunx launch recipes and
Bun install hooks; these are cached installation candidates, not preinstalled
extension agents. No extension is installed by this change. The source examples
and test fixtures are not bundled extension installs. This check does not promise
that a future mutable Hub index is unchanged.
