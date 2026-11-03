"""Synthetic loopback fixtures derived from ACP 117cf6c9 (Apache-2.0)."""
import asyncio
import contextlib
import json
import os
from pathlib import Path

def isolated_environment(root):
    env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "WINDIR", "TMP", "TEMP") if k in os.environ}
    env.update(HOME=str(root / "home"), USERPROFILE=str(root / "home"),
               AELIX_CODING_AGENT_DIR=str(root / "agent"),
               AELIX_CODING_AGENT_SESSION_DIR=str(root / "sessions"),
               AELIX_SETTINGS_PATH=str(root / "agent/settings.json"),
               AELIX_AUTH_PATH=str(root / "agent/auth.json"), PYTHONUNBUFFERED="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    return env


class Fixture:
    def __init__(self, root):
        self.root, self.requests, self.handlers = root, [], set()
        self.entered, self.release = asyncio.Event(), asyncio.Event()

    async def start(self):
        self.server = await asyncio.start_server(self.respond, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        for name in ("home", "agent", "workspace"):
            (self.root / name).mkdir()
        models = {"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions",
            "apiKey": "synthetic-fixture-key", "models": [{"id": name, "name": name, "reasoning": True,
                "input": ["text"], "contextWindow": 32768, "maxTokens": 1024} for name in ("one", "two")]}}}
        for name, value in (("models.json", models), ("settings.json", {"defaultProvider": "fixture", "defaultModel": "one"}),
                            ("auth.json", {"fixture": {"type": "api_key", "key": "synthetic-fixture-key"}})):
            (self.root / "agent" / name).write_text(json.dumps(value))
        self.env = isolated_environment(self.root)

    async def respond(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            header = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)).decode()
            length = int(next(l.split(":", 1)[1] for l in header.split("\r\n") if l.lower().startswith("content-length:")))
            request = json.loads(await reader.readexactly(length))
            self.requests.append(request)
            if "QUALIFICATION_HOLD" in json.dumps(request["messages"][-1]):
                self.entered.set()
                await self.release.wait()
            chunks = []
            for delta, finish in (({"role": "assistant", "content": "QUALIFICATION_OK"}, None), ({}, "stop")):
                chunks.append({"id": "fixture", "object": "chat.completion.chunk", "created": 0,
                    "model": request["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                    "usage": {"prompt_tokens": 17, "completion_tokens": 3, "total_tokens": 20}})
            body = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()
            self.handlers.discard(task)

    async def close(self):
        self.release.set()
        self.server.close()
        await self.server.wait_closed()
        for task in list(self.handlers):
            task.cancel()
        await asyncio.gather(*self.handlers, return_exceptions=True)


class ToolFixture(Fixture):
    next_tool = None

    async def respond(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            header = (await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)).decode()
            length = int(next(line.split(":", 1)[1] for line in header.split("\r\n") if line.lower().startswith("content-length:")))
            request = json.loads(await reader.readexactly(length))
            self.requests.append(request)
            if "QUALIFICATION_HOLD" in json.dumps(request["messages"][-1]):
                self.entered.set()
                await self.release.wait()
            tool, self.next_tool = self.next_tool, None
            if tool:
                name, args = tool
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "synthetic-call-" + str(len(self.requests)),
                    "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
                finish = "tool_calls"
            else:
                delta, finish = {"role": "assistant", "content": "PERMISSION_OK"}, "stop"
            chunks = [{"id": "fixture", "object": "chat.completion.chunk", "created": 0, "model": "one",
                       "choices": [{"index": 0, "delta": d, "finish_reason": f}]} for d, f in ((delta, None), ({}, finish))]
            body = ("".join("data: " + json.dumps(c) + "\n\n" for c in chunks) + "data: [DONE]\n\n").encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\nContent-Length: "
                         + str(len(body)).encode() + b"\r\n\r\n" + body)
            await writer.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(ConnectionError):
                await writer.wait_closed()
            self.handlers.discard(task)
