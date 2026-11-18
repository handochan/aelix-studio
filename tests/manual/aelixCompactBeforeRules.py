"""Exercise first-turn compaction through a source-built Studio host and real ACP."""

import argparse
import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
from threading import Thread
import time
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
ACP_ENTRY = (
    "import sys; sys.path.insert(0, sys.argv.pop(1)); "
    "from aelix_acp.server import main; main()"
)


def checkout_head(source):
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=source, text=True)
    if status:
        raise ValueError(f"Expected a clean source checkout at {source}")
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()


@contextlib.contextmanager
def loopback_provider():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(request)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for delta, finish in (({"role": "assistant", "content": "Fixture reply"}, None), ({}, "stop")):
                chunk = {
                    "id": "fixture", "object": "chat.completion.chunk", "created": 0,
                    "model": request["model"],
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                if finish:
                    chunk["usage"] = {"prompt_tokens": 23, "completion_tokens": 3, "total_tokens": 26}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port, requests
        finally:
            server.shutdown()
            thread.join()


@contextlib.contextmanager
def start_host(host, runtime, sandbox, provider_port):
    for name in ("home", "agent", "extensions"):
        (sandbox / name).mkdir()
    model = {"id": "one", "name": "Fixture", "reasoning": False, "input": ["text"],
             "contextWindow": 32768, "maxTokens": 1024}
    (sandbox / "agent/models.json").write_text(json.dumps({"providers": {"fixture": {
        "baseUrl": f"http://127.0.0.1:{provider_port}/v1", "api": "openai-completions",
        "apiKey": "synthetic-fixture", "models": [model],
    }}}))
    settings = sandbox / "agent/settings.json"
    settings.write_text(json.dumps({"defaultProvider": "fixture", "defaultModel": "one"}))
    env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "SYSTEMROOT", "WINDIR") if key in os.environ}
    env.update(
        HOME=str(sandbox / "home"), USERPROFILE=str(sandbox / "home"),
        PYTHONDONTWRITEBYTECODE="1",
        AELIX_CODING_AGENT_DIR=str(sandbox / "agent"),
        AELIX_CODING_AGENT_SESSION_DIR=str(sandbox / "sessions"), AELIX_SETTINGS_PATH=str(settings),
        AIONUI_BUNDLED_MANAGED_RESOURCES=str(runtime / "aioncore/managed-resources"),
        AIONUI_EXTENSIONS_PATH=str(sandbox / "extensions"),
        AIONUI_EXTENSION_STATES_FILE=str(sandbox / "extension-states.json"),
    )
    log = sandbox / "host.log"
    with log.open("w") as output:
        process = subprocess.Popen(
            [host, "--local", "--port", "0", "--data-dir", sandbox / "data",
             "--managed-resources-mode", "bundled"], cwd=sandbox, env=env,
            stdout=output, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                contents = log.read_text()
                if process.poll() is not None:
                    raise RuntimeError(contents[-3000:])
                if "AIONCORE_READY" in contents:
                    port = next(json.loads(line.partition(" ")[2])["port"] for line in contents.splitlines()
                                if line.startswith("AIONCORE_LISTENING "))
                    break
                time.sleep(0.05)
            else:
                raise TimeoutError(contents[-3000:])

            def api(route, method="GET", payload=None):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{port}{route}", method=method,
                    data=json.dumps(payload).encode() if payload is not None else None,
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=60) as response:
                    value = json.load(response)
                    return value.get("data", value) if isinstance(value, dict) else value

            yield api
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=25)


def send_and_wait(api, conversation, text):
    route = f"/api/conversations/{conversation}"
    api(f"{route}/messages", "POST", {"content": text})
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if api(route)["runtime"]["state"] == "idle":
            return api(f"{route}/messages?limit=100")["items"]
        time.sleep(0.05)
    raise TimeoutError(f"Conversation {conversation} did not become idle")


def compact_updates(messages):
    return [item["content"]["_meta"]["aelix/compaction"] for item in messages
            if item["type"] == "acp_tool_call" and "aelix/compaction" in item["content"].get("_meta", {})]


def verify_cases(api, runtime, adapter, sandbox, requests, contract):
    native_bin = runtime / "native" / ("Scripts" if os.name == "nt" else "bin")

    def executable(name):
        return str(native_bin / (name + (".exe" if os.name == "nt" else "")))

    name = "Compact before rules fixture"
    api("/api/agents/custom", "POST", {
        "name": name, "command": executable("python"),
        "args": ["-B", "-c", ACP_ENTRY, str(adapter / "src"), "--aelix", executable("aelix"),
                 "--state-dir", str(sandbox / "acp")], "env": [], "icon": "C",
    })
    assistant = next(item for item in api("/api/assistants") if item["name"] == name)

    def conversation(label, excluded_skills=()):
        workspace = sandbox / label
        workspace.mkdir()
        return api("/api/conversations", "POST", {
            "name": label, "assistant": {"id": assistant["id"]},
            "extra": {"workspace": str(workspace), "custom_workspace": True,
                      "exclude_auto_inject_skills": list(excluded_skills)},
        })

    leading = conversation("leading-command")
    skills = leading["extra"]["skills"]
    assert skills, "The leading command case needs pending host-generated rules"
    messages = send_and_wait(api, leading["id"], contract["command"])
    assert len(requests) == contract["providerRequestsForCommand"], "A leading /compact reached the provider"
    assert compact_updates(messages) == [{"reason": "manual", "state": "failed"}], (
        "The empty native session should attempt compaction and report no compactable history"
    )
    send_and_wait(api, leading["id"], contract["nextPrompt"])
    first_model_input = requests[-1]["messages"][-1]["content"]
    assert first_model_input.startswith(contract["rulesOpening"])
    assert first_model_input.endswith(contract["rulesClosing"] + contract["nextPrompt"])
    followup = "Continue after the rules were delivered"
    send_and_wait(api, leading["id"], followup)
    assert requests[-1]["messages"][-1]["content"] == followup

    pasted = conversation("pasted-example", skills)
    assert not pasted["extra"]["skills"], "The pasted input should carry only the user's rules-shaped text"
    before = len(requests)
    messages = send_and_wait(api, pasted["id"], contract["pasted"])
    assert len(requests) - before == contract["providerRequestsForPaste"]
    assert requests[-1]["messages"][-1]["content"] == contract["pasted"]
    assert not compact_updates(messages), "Pasted example unexpectedly entered native compaction"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, type=Path, help="Binary built from the host feature branch")
    parser.add_argument("--host-source", required=True, type=Path, help="Clean checkout used to build --host")
    parser.add_argument("--runtime", required=True, type=Path, help="Prepared Studio runtime for the native pin")
    parser.add_argument("--acp-source", required=True, type=Path, help="Clean ACP feature-branch checkout")
    args = parser.parse_args()
    host, runtime, adapter = (path.resolve() for path in (args.host, args.runtime, args.acp_source))
    host_head, acp_head = checkout_head(args.host_source), checkout_head(adapter)
    baseline = json.loads((ROOT / "scripts/studio-preview/baseline.json").read_text())
    native_pin = baseline["native"]["sourceTag"]["commit"]
    receipt = json.loads((runtime / "receipt.json").read_text())
    assert receipt["native"]["sourceTag"]["commit"] == native_pin, "Prepared native runtime differs from the Studio pin"
    contract = json.loads((ROOT / "tests/fixtures/aelix-context-controls.json").read_text())["firstCompactBeforeRules"]
    with tempfile.TemporaryDirectory(prefix="studio-compact-rules-") as directory, loopback_provider() as provider:
        sandbox = Path(directory)
        port, requests = provider
        with start_host(host, runtime, sandbox, port) as api:
            verify_cases(api, runtime, adapter, sandbox, requests, contract)
    print(json.dumps({"host": host_head, "hostBinarySha256": hashlib.sha256(host.read_bytes()).hexdigest(),
                      "acp": acp_head, "native": native_pin,
                      "passed": ["firstCompactBeforeRules", "rulesOnNextOrdinaryTurn", "pastedCompactIsOrdinary"]}))


if __name__ == "__main__":
    main()
