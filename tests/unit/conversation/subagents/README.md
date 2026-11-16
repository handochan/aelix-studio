# Studio #31 contract fixtures and blocked preflight

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

Each frame's children array is a complete snapshot. Resume retains the child ID
but changes the parent call ID. The earlier parent's last snapshot remains in
history. Cross-call display continuity is still unimplemented and unverified.

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

The user explicitly excluded manifest/lockfile/native changes and required
stopping if they became necessary. Renderer implementation therefore did not
start. Resolve the dependency ownership/scope first, then repeat native import
and actual host preflight before implementing the panel. S1, S2, cancellation,
reload, live metadata delivery and real-model acceptance remain unverified.
No host/ACP/native/pin/manifest/lockfile or CI changes are included here.

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
