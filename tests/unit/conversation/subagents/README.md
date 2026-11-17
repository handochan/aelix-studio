# Subagent fixtures

`frames.json` fixes the documented ACP metadata example plus snapshots from
[`16d6555b08825d1d63c3b082de2b10a1152562c0`](https://github.com/handochan/aelix-acp/tree/16d6555b08825d1d63c3b082de2b10a1152562c0).
Sources: `docs/studio-integration.md` (Delegated children),
`src/aelix_acp/runtime/subagents.py`, `tests/test_subagents.py` (`progress()`),
and `tests/test_native_runtime.py`. All named snapshots are exercised by tests.

Regenerate by reading those files with `git show <pin>:<path>` (do not modify
the ACP checkout), loading the pinned `SubagentTracker` and test `progress()`
helper, and recording this sequence:

| Frame       | Input event / child state                                         |
| ----------- | ----------------------------------------------------------------- |
| documented  | Copy the exact JSON example from the integration document         |
| starting    | call-1 start; subagent_start / sub-1 starting                     |
| running     | subagent_tool / sub-1 running, current_tool=read, elapsed_ms=2300 |
| twoChildren | subagent_start / sub-2 starting                                   |
| completed   | subagent_end / sub-1 done, elapsed_ms=3000                        |
| stopped     | subagent_end / sub-2 stopped, elapsed_ms=3100                     |
| resumed     | end call-1, start call-resume; subagent_start / sub-2 running     |
| failed      | subagent_end / sub-2 error, elapsed_ms=4000                       |

Use `progress()` defaults for other input fields; serialize each returned
`_meta` under a standard `tool_call_update` envelope. The tracker-only resume
reuses its supplied ID; actual native resume creates a new progress ID.

`nativeFrames.json` contains two real persisted aelix.4 tool messages for one
parent call and a subsequent resume call, using pinned ACP/native and a
synthetic model. Both frames are consumed by the DOM test. To refresh from a
built local runtime, run:

```sh
node scripts/studio-preview/host-release/subagentSmoke.mjs \
  --runtime <payload> --prepared <prepared-runtime> --output <probe-output>
```

Select the cancelled parent and resumed parent from `<probe-output>/frames.json`,
store their `content` under one shared scenario name, and update the DOM test's
scenario selector if it changes. Keep provenance/pins in the `source` field;
UUIDs and timing values are capture-specific. This regenerates semantic cases,
not byte-identical identifiers.

Signal-boundary fixtures intentionally retain reported running states while a
new conversation turn is active: current ACP rows do not provide a host turn
ID, and `backend_turn_id` is a provider fork anchor. Reconciling those calls
requires an explicit per-call turn-ended signal or matching host turn IDs.
No new store/subscription is used. A stopped child followed by a new child is
unreachable in the pinned native and remains outside these fixtures until S3.
Before the first subagent metadata frame, the item is an ordinary tool and is
not projected, even with a known idle conversation. Identifying that case needs
an explicit per-call subagent/lifecycle signal rather than a title guess.
