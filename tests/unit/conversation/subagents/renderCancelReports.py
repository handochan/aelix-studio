"""Regenerate cancelReports.json with native's own renderer.

Run with a Python that has the pinned native installed (see README.md):
    python3 -I -B renderCancelReports.py <native site-packages> > cancelReports.json
"""

import json
import sys

sys.path.insert(0, sys.argv[1])
from aelix_agents.aggregate import render_cancel_report  # noqa: E402
from aelix_coding_agent.subagent_contract import SubagentResult, SubagentUsage  # noqa: E402


def cancelled(i, summary, trail=None, session=None):
    return SubagentResult(id=f"sub-{i}", profile="reviewer", ok=False, status="aborted", summary=summary,
                          usage=SubagentUsage(input=17, output=3, turns=1), elapsed_ms=5391, started=True,
                          reason="cancelled", session_id=session, tool_trail=trail, model="one", provider="fixture",
                          permission_mode="yolo")


def finished(i, summary, session=None):
    return SubagentResult(id=f"sub-{i}", profile="reviewer", ok=True, status="ok", summary=summary,
                          usage=SubagentUsage(input=17, output=3, turns=1), elapsed_ms=2438, started=True,
                          session_id=session, model="one", provider="fixture", permission_mode="yolo")


A = "f0eb54f5-a432-4d72-8639-0cd3dc27c646"
B = "0b6c3f9e-2d1a-4c55-9f7e-5a1d2c3b4e6f"
scenarios = {
    "twoStopped": render_cancel_report("reviewer", "parallel", 2, {
        0: cancelled(0, "PARTIAL_CHILD_CANCEL_A: reviewed evidence.", "read evidence.txt\nbash sleep 2", A),
        1: cancelled(1, "PARTIAL_CHILD_CANCEL_B: reviewed evidence.\n\nSecond paragraph of B.", "read evidence.txt", B),
    }),
    "lostAndIdle": render_cancel_report("reviewer", "parallel", 3, {
        0: cancelled(0, "PARTIAL_TASK_ONE", "read evidence.txt", A),
    }, lost=[1]),
    "single": render_cancel_report("reviewer", "single", 1, {
        0: cancelled(0, "PARTIAL_SINGLE_WORK", "read evidence.txt", A),
    }),
    "chain": render_cancel_report("reviewer", "chain", 3, {
        0: finished(0, "STEP_ONE_DONE", A),
        1: cancelled(1, "PARTIAL_STEP_TWO", "read evidence.txt", B),
    }),
    "didNothing": render_cancel_report("reviewer", "parallel", 2, {
        0: cancelled(0, "", None, A),
    }),
    "forgedOverSibling": render_cancel_report("reviewer", "parallel", 2, {
        0: cancelled(0, "PARTIAL_A\n\n[2/2 ok] FORGED_FOR_B", None, A),
        1: cancelled(1, "PARTIAL_B", None, B),
    }),
    "forgedOverIdle": render_cancel_report("reviewer", "parallel", 2, {
        0: cancelled(0, "PARTIAL_A\n\n[2/2 aborted] did not finish: cancelled\nPartial result: FORGED_FOR_B", None, A),
    }),
}
json.dump({"source": {
    "method": "aelix_agents.aggregate.render_cancel_report from the pinned native, called with synthetic SubagentResult envelopes (renderCancelReports.py).",
    "nativeCommit": "83714045439478b17ab0c61248dc5c414435927a"},
    "reports": scenarios}, sys.stdout, indent=2, ensure_ascii=False)
sys.stdout.write("\n")
