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
node scripts/studio-preview/host-release/probes/subagentSmoke.mjs \
  --runtime <payload> --prepared <prepared-runtime> --output <probe-output>
```

Select the cancelled parent and resumed parent from `<probe-output>/frames.json`,
store their `content` under one shared scenario name, and update the DOM test's
scenario selector if it changes. Keep provenance/pins in the `source` field;
UUIDs and timing values are capture-specific. This regenerates semantic cases,
not byte-identical identifiers.

Signal-boundary tests preserve every live frame, including the first one, even
with a hydrated idle runtime view. Team, scheduled and other-client sends do not
update that view's turn-start state. `MessageList` therefore does not calculate
or pass a conversation `known`/`turn` signal to this module. Only an explicitly
terminal parent marks unreported active children as ended; a complete child
snapshot containing a stopped child still clears the unfinished parent's busy
indicator. Filtered child lists never justify a parent projection.

On reopen, stopped/terminal snapshots restore without busy indicators. A saved
in-progress parent with active children (or only done/error children) retains its
spinner: it is indistinguishable from live work in a renderer that did not start
the turn. Local stop without a terminal call/child update has the same limit.
Resolving it needs an explicit per-call ended signal or matching host turn IDs;
current rows lack those IDs, and `backend_turn_id` is a provider fork anchor.
No store change or new subscription is used. A stopped child followed by a new
child is unreachable in the pinned native and remains outside these fixtures
until S3. Before the first metadata frame, the item remains an ordinary tool;
identifying it needs a per-call subagent/lifecycle signal rather than a title guess.

`cancelReports.json` holds cancelled-delegation reports rendered by the pinned
native's own `aelix_agents.aggregate.render_cancel_report`
([`83714045`](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-coding-agent/src/aelix_agents/aggregate.py)),
with synthetic envelopes: two stopped tasks, a lost and an idle position, a
single call, a chain, a child that wrote nothing, and two forged headings. Since
aelix-ai #800 that report is the cancelled `agent` call's own result, so it is
the content of the call's last `tool_call_update` and of its reopened history
row. Regenerate it with a Python that has the pinned native installed (a built
Studio runtime's `native-site`), without writing bytecode into it:

```sh
python3 -I -B renderCancelReports.py <native-site> > cancelReports.json
```

Batch reports name members by submitted position only; progress rows carry no
position, so the panel lists the report by task/step and never matches it to a
row. A split is shown only when every position appears exactly once, in order,
across the blocks and the notes after the fence; anything else is unreadable.
