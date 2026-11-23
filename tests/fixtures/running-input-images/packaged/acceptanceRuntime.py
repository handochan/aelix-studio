"""Observe writes from the bundled ACP and redirect its native Codex HTTP transport."""
import asyncio
import base64
import contextvars
import hashlib
import json
import os
from pathlib import Path
import runpy
import sqlite3
import sys
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

ROUTE = "https://chatgpt.com/backend-api/codex/responses"
CAPTION = "The user attached one or more images."
COMMANDS = {"prompt", "steer", "follow_up", "abort"}


def fixture_provider_endpoint():
    endpoint = urlsplit(os.environ["STUDIO_FIXTURE_PROVIDER"])
    if (endpoint.scheme, endpoint.hostname, endpoint.path) != ("http", "127.0.0.1", "/responses"):
        raise ValueError("Invalid fixture provider")
    return endpoint


def check_mixed_references(text):
    # The test driver keeps the independently resolved expectations in memory.
    # Compare this pipe frame here and persist only the match results.
    endpoint = fixture_provider_endpoint()._replace(path="/fixture/mixed-references").geturl()
    with build_opener(ProxyHandler({})).open(endpoint, timeout=5) as response:
        expected = json.load(response)
    _, files_marker, files = text.partition("\n[[AION_FILES]]\n")
    _, sessions_marker, sessions = text.partition("\n[[AION_SESSIONS]]\n")
    session_block, sessions_end, _ = sessions.partition("\n[[/AION_SESSIONS]]")
    return {
        "nativeFileRefMatches": bool(files_marker and files.splitlines() == [expected["filePath"]]),
        "nativeSessionRefMatches": bool(
            sessions_marker and sessions_end and session_block.splitlines()[1:] == [expected["sessionRow"]]
        ),
    }


def observe_acp(bundle, arguments):
    sys.path.insert(0, str(bundle / "adapter-site"))
    from aelix_acp import image_policy
    from aelix_acp.session import Session

    receipt = Path(os.environ["STUDIO_FIXTURE_WRITES"])
    native_pipe = contextvars.ContextVar("native_pipe", default=None)
    original_rpc = Session.rpc
    original_write = asyncio.StreamWriter.write

    async def rpc(self, command, **kwargs):
        if command not in COMMANDS or self.proc is None:
            return await original_rpc(self, command, **kwargs)
        marker = native_pipe.set((self.proc.stdin, self.proc.pid))
        try:
            return await original_rpc(self, command, **kwargs)
        finally:
            native_pipe.reset(marker)

    def append_observation(observation):
        with receipt.open("a", encoding="ascii") as stream:
            stream.write(json.dumps(observation) + "\n")

    def observe_mixed(observation, text):
        try:
            observation.update(check_mixed_references(text))
        except (OSError, ValueError, KeyError):
            observation.update(nativeFileRefMatches=False, nativeSessionRefMatches=False)
        append_observation(observation)

    def write(writer, data):
        result = original_write(writer, data)
        target = native_pipe.get()
        if target is not None and writer is target[0]:
            frame = json.loads(data)
            images = []
            for image in frame.get("images", []):
                encoded = image["data"].removeprefix(image_policy.RUNNING_IMAGE_WIRE_PREFIX)
                raw = base64.b64decode(encoded, validate=True)
                images.append({"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
            text = frame.get("message") or ""
            paths = 0
            if "\n[[AION_FILES]]\n" in text:
                paths = len(text.split("\n[[AION_FILES]]\n", 1)[1].splitlines())
            observation = {
                "method": frame["type"], "images": images, "captionAdded": text == CAPTION,
                "pathCount": paths, "acpPid": os.getpid(), "nativePid": target[1],
            }
            if frame["type"] == "follow_up" and "[[AION_SESSIONS]]" in text:
                # Resolve comparison data off the pipe writer's event loop so
                # the probe does not delay the native acknowledgment.
                asyncio.get_running_loop().run_in_executor(None, observe_mixed, observation, text)
            else:
                append_observation(observation)
        return result

    Session.rpc = rpc
    asyncio.StreamWriter.write = write
    prefix = ["-I", "-S", "-B", "-Xutf8", str(Path(__file__).resolve()), str(bundle), "native"]
    return ["--aelix", sys.executable, *["--aelix-arg=" + arg for arg in prefix], *arguments]


def redirect_codex(bundle):
    sys.path.insert(0, str(bundle / "native-site"))
    import httpx
    from aelix_ai.providers import openai_codex_responses as codex

    endpoint = fixture_provider_endpoint()

    # Adapt ACP's test_native_image_prompt.py MockTransport pattern. The native
    # client still serializes a real Codex Responses request on the A-1b route.
    async def capture(request):
        if request.method != "POST" or str(request.url) != ROUTE:
            return httpx.Response(400)
        async with httpx.AsyncClient(trust_env=False, timeout=90) as loopback:
            return await loopback.post(endpoint.geturl(), content=request.content)

    codex._get_account_id = lambda _: "fixture-account"
    codex._create_codex_client = lambda _: httpx.AsyncClient(
        transport=httpx.MockTransport(capture), trust_env=False
    )


def seed_builtin(database):
    command, arguments, environment = json.load(sys.stdin)
    with sqlite3.connect(database) as db:
        db.execute(
            """INSERT INTO agent_metadata
            (id, agent_id, name, backend, agent_type, agent_source, command, args, env, created_at, updated_at)
            VALUES ('fixture-images','fixture-images','Image Acceptance','aelix','acp','builtin',?,?,?,1,1)""",
            (command, json.dumps(arguments), json.dumps(environment)),
        )


def main():
    if sys.argv[1] == "seed":
        seed_builtin(sys.argv[2])
        return
    directory, mode, *arguments = sys.argv[1:]
    bundle = Path(directory).resolve()
    if mode == "acp":
        arguments = observe_acp(bundle, arguments)
    elif mode == "native":
        redirect_codex(bundle)
    else:
        raise ValueError("Invalid fixture mode")
    launch = str(bundle / "launch.py")
    sys.argv = [launch, mode, *arguments]
    runpy.run_path(launch, run_name="__main__")


if __name__ == "__main__":
    main()
