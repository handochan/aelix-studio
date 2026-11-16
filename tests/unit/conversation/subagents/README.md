# Studio #31 contract fixtures and validation

Current scope after the coordinator correction: a resumed run renders under its
new `agent` call. No cross-call row linking, result-text inference, contract
change or pin change is required. The independent progress panel and inherited
bytecode protection are implemented. Actual acceptance remains blocked only on
immediate stopped-child work results, which the current native/ACP wire does
not publish. Historical checkpoints below are retained as dated evidence.

`frames.json` freezes `_meta["aelix/subagents"]` version 1 before renderer work.
The canonical source is ACP
[`16d6555b08825d1d63c3b082de2b10a1152562c0`](https://github.com/handochan/aelix-acp/tree/16d6555b08825d1d63c3b082de2b10a1152562c0):

- `docs/studio-integration.md`, Delegated children: `documented` is the exact
  JSON example, including its illustrative `sub-…` ID.
- `tests/test_subagents.py`: `progress()` supplies the tracker test inputs.
- `src/aelix_acp/runtime/subagents.py`: the unmodified `SubagentTracker`
  generates the remaining `_meta` snapshots. Starting/running/done and resume
  follow its tests; stopped/error and a second child extend the documented enum.
- `tests/test_native_runtime.py`,
  `test_delegated_child_progress_rides_the_parent_tool_call`: verifies the live
  update envelope and completed child state. The frozen snapshots are contract
  examples, not captured provider output or evidence of UI acceptance.

Each frame's children array is a complete snapshot. The tracker-only resume
example supplies the same child ID to a new parent call. It does not establish
that native emits the same ID on resume. Actual pinned-native observations
below show new progress IDs, so this example must not be used as evidence of
cross-call row continuity.

## Preflight blocker (2026-11-16)

`preflight.json` records an isolated macOS arm64 probe using the released
`host-v0.2.2-aelix.4` and a copied, unchanged packaged runtime from Studio #28.
The current baseline SHA-256 matches the payload manifest, and the existing
packaging verifier passed identity, recipe and complete inventory verification:

```sh
node scripts/studio-preview/packaging/build.mjs \
  --runtime <prepared-runtime> --payload <copied-payload> --verify-only
```

The first synthetic model response requested native `agent` with two parallel
tasks. ACP persisted `agentsEnabled: true`, but native did not advertise `agent`.
The host recorded `Unknown tool: agent`, no children ran, and no subagent `_meta`
was generated. Native stderr reported:

```text
Warning: aelix-agents unavailable: No module named 'rich'
```

Reproduce the import failure without starting a model or host, using the copied
payload's own Python:

```sh
<payload>/python/bin/python3 -I -S -B -c \
  'import sys; sys.path.insert(0, "<payload>/native-site"); from aelix_agents import AgentsExtension'
```

`aelix_agents/tool.py` imports `rich.cells` at module load. Native wheel metadata
declares `rich` only under its `tui` extra; Studio's
`scripts/studio-preview/packaging/native-requirements.in` and `.lock` omit it.
The runtime was not patched and no package was injected. This is a packaged
dependency blocker before progress generation; it is **not evidence that host
metadata persistence or forwarding failed**.

At this initial checkpoint the user excluded manifest/lockfile/native changes
and required stopping if they became necessary. Renderer implementation did
not start. The user subsequently authorized the narrow `rich` addition below;
the original `preflight.json` remains a historical record.

## Checkpoint validation

- The isolated host probe made two synthetic loopback requests; it did not run
  a child or use a real provider. The separate bundled import probe reproduced
  the same missing dependency without a model.
- An independent read-only review repeated payload verification and the import
  failure and confirmed the stop boundary. It did not accept S1 or S2 behavior.
- Local lint (warnings only), formatting, TypeScript, i18n generation/validation,
  and the existing full Vitest suite passed: 535 files, 5,150 tests; one file and
  seven tests skipped. The existing Electron bundle also built successfully.
- No parser or component tests were added because their implementation is
  blocked. No renderer UI flow, real-model call, installation matrix or whole-app
  outbound audit was run. This checkpoint does not complete Issue #31.

## Rich addition and additional import blocker (2026-11-17)

The user authorized `rich>=13.7,<15`, its new transitive dependencies, and the
resulting bundle inventories/licenses, with no unrelated version changes.
This is the Studio workaround for
[aelix-ai #797](https://github.com/handochan/aelix-ai/issues/797).

The universal hash lock adds only `rich==14.3.4`. Its dependencies
`markdown-it-py==4.2.0` and `pygments==2.21.0` were already present. Every prior
requirement, version, target marker and hash remains identical, including the
Windows requirements. No native/ACP wheel, host or pin was changed.

`richPreflight.json` records a newly generated darwin-arm64 bundle. The local
`uv 0.11.19` cannot download the pinned CPython 3.12.15, so preparation reused the
prior inventory-verified standalone interpreter and created fresh native and
adapter environments. The committed preparation and bundle recipes were not
modified. The existing identity/recipe/full-inventory verifier passed, and the
rebuilt native and ACP wheel hashes are unchanged. Rich's MIT license is
preserved at `native-site/rich-14.3.4.dist-info/licenses/LICENSE` and covered by
the new generated inventory; its digest is recorded in `richPreflight.json`.

`import rich.cells` succeeds in the new bundle, but the user's required
`import aelix_agents.tool` fails at `aelix_agents/panel.py:50`:

```text
ModuleNotFoundError: No module named 'wcwidth'
```

Confirmed additional missing package: **`wcwidth`**. Native metadata declares
`wcwidth>=0.3.0` only under the `tui` extra. It is not a Rich dependency. An
independent read-only review reproduced the failure and verified lock/license
preservation. The user explicitly required stopping on another missing native
import rather than adding it, so `wcwidth` was not installed or locked.
This is the first subsequent import failure, not an exhaustive dependency audit.

The actual-host preflight was not rerun after this import failure, and S1/S2
implementation did not start. Agent advertisement, two-child execution,
metadata delivery to the renderer, cancellation/partial results, reload and
resume continuity remain unverified. Decide the additional dependency scope
before rebuilding and repeating import → actual host → renderer validation.
CI workflows, host/ACP/native code and all pins remain unchanged.

## Wcwidth addition and native metadata preflight (2026-11-17)

The user extended approval to the native `tui` extra and requested adding
`wcwidth>=0.3.0` now. The lock adds only `wcwidth==0.9.4`; every previous
requirement, version, marker and hash is unchanged. Both required bundled
imports (`aelix_agents.tool` and `aelix_agents.panel`) pass. `prompt-toolkit`
was not needed by these imports and was not added. Rich and Wcwidth LICENSE
files are included in the generated payload inventory. Native/ACP wheel
hashes, host and pins are unchanged. Preparation reused the same verified
standalone CPython as described above.

`nativePreflight.json` and `nativeFrames.json` record actual released aelix.4
host and Electron probes with a synthetic loopback model:

- The model is advertised `agent`, two children complete, and their progress
  metadata persists in **`message.content._meta`**, outside `content.update`.
- An actual Electron send reaches the same native path. React inspection of
  the existing `MessageToolGroupSummary` messages prop finds this metadata.
  The current message list routes calls through that summary, so a direct
  `MessageAcpToolCall` connection and a new progress panel are still unimplemented.
- A synthetic model calls native `agent action=resume` for a **completed**
  child's Session UUID. Native continues that same session, but its metadata
  child ID changes from `sub-572cb34b2228` to `sub-1c30c67a5a2b` under a new
  parent call. This is not stopped-child resume or cancellation acceptance.

### Historical S2 continuity stop (same-row requirement withdrawn)

Pinned native `aelix_agents/runtime.py` allocates a new `spawn_id` with
`_new_id()` for every run, including resume. Its receipt has a `resumes` link,
but the progress wire and pinned ACP snapshot do not expose it. Metadata v1
has neither the child Session UUID nor `resumes`/`previousId`/another linking
key. The outer `content.session_id` is the parent ACP session and cannot
identify the child. Both original children share profile/model/provider, so
matching those values or list order is ambiguous.

The user's UI input is one `_meta` value, and S2 requires continuing the same
child row. Result-text `Session:` parsing or `raw_input.id` would leave that
input contract. An independent read-only review confirmed this gap in the
actual frames and pinned source. Preserving the same-row requirement needs a
metadata continuity contract and associated native/ACP pin approval. Those
changes are excluded, so implementation stopped at this boundary; no renderer
source, global store, S3 or new resume control was added.

### Inventory boundary

A fresh generated payload passes the existing strict identity/recipe/full
inventory verifier. During the initial live probes, native child processes
created 2,230 bytecode cache files in the executed payload; no existing
inventory entry changed. The strict post-delegation inventory check therefore
fails on the extra caches. The executed payload is preserved and this limit is
recorded separately from the fresh-payload verification. No runtime or native
code was patched to suppress it; post-delegation bundle immutability remains
unqualified.

The parser/component panel, live progress display, cancellation/partial results,
reopening/restoration, stopped-child resume, and same-row continuity remain
unimplemented or unverified. No real-provider call, local five-target install
or whole-app outbound audit was performed. This checkpoint does not complete
Issue #31.

## Renderer implementation and current acceptance

`SubagentProgress` is an independent renderer module with one input:
`message.content._meta["aelix/subagents"]`. It does not import the conversation
store, IPC or native APIs. The actual message list renders generic ACP tools
through `MessageToolGroupSummary`, so the panel is attached below each
normalized tool header there. Metadata is selected by that parent tool-call ID;
new resume calls retain their own new rows. No state was added to an Aion or
global store. Interrupted results open automatically, including full-message
loading for compact history. Existing tool input/output remains the parent
call's result display.

The parser handles absent/invalid data, unknown fields and versions, duplicate
IDs, invalid metrics and the 32-child bound. Unknown versions render the
ordinary tool view. Text is bounded and rendered as text, zero metrics are
preserved, token counts are formatted as exact integers, and labels use all
configured locales. Elapsed time is the latest reported runtime snapshot.

Both Studio runtime entrypoints force `PYTHONDONTWRITEBYTECODE=1`; the Python
entrypoint also sets `sys.dont_write_bytecode`. The existing installed smoke
challenges this with an incoming value of `0`, delegates to two real native
children, and compares the entire payload inventory. A descendant-interpreter
unit test guards the direct Python entrypoint. Local actual Electron/native
execution now leaves strict bundle inventory unchanged, including after
cancellation and resume. Native and ACP source/wheels/pins are unmodified.

Run the source-app acceptance probe after building Electron and the payload:

```sh
node scripts/studio-preview/host-release/subagentSmoke.mjs \
  --runtime <payload> --prepared <prepared-runtime> --output <report-directory>
```

The probe deliberately keeps its full-acceptance assertion failing while the
upstream partial-result gap below remains. It records all independent checks
before that assertion, plus actual wire frames and screenshots. This is not a
passing full S1 acceptance test.

### Current blocker: cancelled work is not emitted as a tool result

Actual aelix.4 host + bundled native + Electron, synthetic loopback model:

- Two running children, current `bash` tool, reported usage and completion render.
- UI Stop makes both child states `stopped`; the turn becomes idle.
- On the next chat request, the model receives native's queued cancellation
  report and calls `agent action=resume` for a stopped child. The new call's new
  child row reaches `done`. No UI row linking or UI result-string parser exists.
- Native child failure renders `error`; page reload restores the persisted
  stopped/error/resumed metadata.
- After the app closes, the full runtime inventory is identical and the strict
  packaging verifier passes.

But the cancelled parent call retains only two `[stopped]` progress lines,
without its children's work. Pinned native's `CancelledError` path queues that
report with `api.send_message(..., trigger_turn=False)` for the **next model
turn**, then propagates cancellation without returning a `ToolResult`. The
richer TUI linger display is separate. No `tool_execution_end` containing the
cancelled work reaches ACP, so a full-message fetch cannot recover it. Its
pending queue is memory-only, not a persisted UI result.

An independent read-only source/wire review confirmed this gap. Emitting a
standard cancelled-tool result needs native/ACP ownership and pin approval,
which are excluded. No automatic follow-up model call or direct child-JSONL
read was added. Immediate partial-result display and its history restoration
therefore remain unaccepted; Issue #31 is not complete.

`uiAcceptance.json` records the observed acceptance split. Same-row continuity
is only a known limitation: resume creates a new progress ID and metadata v1
has no child Session UUID or resume link. It is no longer a blocker or a
requirement for this PR. S3 and new resume controls remain excluded.

Current local checks: full Vitest 537 files / 5,178 tests passed (7 skipped),
preview Python 219 tests (9 skipped), TypeScript/lint/format/i18n/build passed.
The new renderer module has 100% line and 97.72% branch coverage in focused
coverage validation. The actual Electron acceptance probe records seven passed
checks and exits 1 for the missing immediate cancelled-work result. Its fixture
includes completed assistant work before cancellation, rather than requiring
only an unfinished streaming delta to survive.
