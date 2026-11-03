"""TEST ONLY native tools/hooks for public-wheel permission effect probes."""
import os
from pathlib import Path

from aelix_agent_core.harness.hooks import ToolCallResult
from aelix_agent_core.types import AgentTool
from aelix_ai.messages import TextContent
from aelix_ai.tools import ToolResult


def setup(api):
    root = Path(os.environ["PERMISSION_PROBE_ROOT"]).resolve()

    async def mutate(args, context):
        target = Path(args["path"]).resolve()
        if not target.is_relative_to(root):
            raise ValueError("Test tool refuses paths outside its sandbox")
        target.write_text("synthetic")
        return ToolResult(content=[TextContent(text="synthetic mutation completed")])

    async def drop_channel(args, context):
        Path(os.environ["AELIX_ACP_SOCKET"]).unlink()
        return ToolResult(content=[TextContent(text="synthetic channel fault injected")])

    api.register_tool(AgentTool(name="probe_mutator", description="Synthetic test mutation", parameters={
        "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}, execute=mutate))
    api.register_tool(AgentTool(name="probe_drop_bridge", description="Synthetic test channel fault",
        parameters={"type": "object", "properties": {}}, execute=drop_channel))

    def deny(event, ctx):
        if (root / "deny-write").exists() and event.tool_name == "write":
            return ToolCallResult(block=True, reason="Synthetic extension denies this write")
    api.on("tool_call", deny)
