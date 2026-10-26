"""Qualify existing Electron initial/ordinary/queued managed sends, without publication."""

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import signal

from wire import observers

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def run(args):
    sys.path.insert(0, str(args.acp_source / "scripts"))
    from qualify_permissions import ToolFixture
    from beta2_identity import verify
    from qualify_beta2 import adapter_receipt

    manifest = json.loads((args.acp_source / "docs/beta2/manifest.json").read_text())
    audit = lambda: dict(
        native=verify(manifest, args.artifacts), adapter=adapter_receipt(args.adapter)
    )
    before = audit()
    payload_before = (
        {
            p.relative_to(args.payload).as_posix(): digest(p)
            for p in args.payload.rglob("*")
            if p.is_file()
        }
        if args.payload
        else None
    )
    with tempfile.TemporaryDirectory(prefix="studio16-forwarding-ui-") as temporary:
        root = Path(temporary).resolve()
        fixture = ToolFixture(root)
        await fixture.start()
        (root / "extensions").mkdir()
        entry, native, facts, starts = observers(root, args.payload)
        python = os.path.abspath(args.python)
        if args.payload:
            alias = root / "bundled-python"
            if os.name == "nt":
                subprocess.run(
                    [
                        "cmd",
                        "/d",
                        "/c",
                        "mklink",
                        "/J",
                        str(alias),
                        str(args.payload / "python"),
                    ],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
            else:
                alias.symlink_to(args.payload / "python", target_is_directory=True)
            alias_python = alias / ("python.exe" if os.name == "nt" else "bin/python3")
            assert alias_python.samefile(args.python)
            python = str(alias_python)
        isolated = ["-I", "-S", "-B", "-X", "utf8"] if args.payload else ["-I", "-B"]
        argv = [
            *isolated,
            str(entry),
            "--managed-operations",
            "--aelix",
            python,
            *["--aelix-arg=" + arg for arg in isolated],
            "--aelix-arg=" + str(native),
            "--provider",
            "fixture",
            "--model",
            "one",
            "--state-dir",
            str(root / "acp"),
        ]
        env = dict(
            fixture.env,
            OPERATION_FACTS=str(facts),
            FORWARD_SANDBOX=str(root),
            FORWARD_OUTPUT=str(args.report.parent),
            FORWARD_COMMAND=python,
            FORWARD_ARGS=json.dumps(argv),
            AIONUI_E2E_TEST="1",
            AIONUI_E2E_USER_DATA_DIR=str(root / "studio"),
            AIONUI_DISABLE_DEVTOOLS="1",
            AIONUI_DISABLE_AUTO_UPDATE="1",
            AIONUI_CDP_PORT="0",
            AIONUI_EXTENSIONS_PATH=str(root / "extensions"),
            AIONUI_EXTENSION_STATES_FILE=str(root / "extension-states.json"),
        )
        env.update(
            {
                name: os.environ[name]
                for name in ("DISPLAY", "XAUTHORITY")
                if name in os.environ
            }
        )
        if args.payload:
            env["FORWARD_APP_EXECUTABLE"] = os.environ["PROVIDER_APP_EXECUTABLE"]
        else:
            env["AIONUI_BACKEND_BIN"] = str(args.host)
        try:
            process = await asyncio.create_subprocess_exec(
                "node",
                str(HERE / "smoke.mjs"),
                cwd=ROOT,
                env=env,
                **({"start_new_session": True} if os.name != "nt" else {}),
            )
            async with asyncio.timeout(240):
                assert await process.wait() == 0, (
                    "Electron managed forwarding qualification failed"
                )
            result = json.loads(
                (args.report.parent / "renderer-result.json").read_text()
            )
            assert audit() == before
            if args.payload:
                assert payload_before == {
                    p.relative_to(args.payload).as_posix(): digest(p)
                    for p in args.payload.rglob("*")
                    if p.is_file()
                }
            rows = list(map(json.loads, facts.read_text().splitlines()))
            prompts = [
                row["operation"]
                for row in rows
                if row.get("method") == "session/prompt"
            ]
            assert len(prompts) == 3 and len({row["id"] for row in prompts}) == 3
            assert len(fixture.requests) == 3
            result.update(
                status="passed",
                installer=args.payload is not None,
                publicNativeMembers=309,
                nativePatches=[],
                identityBefore=before,
                identityAfter=audit(),
                providerRequests=len(fixture.requests),
                installedPayloadUnchanged=args.payload is not None,
                hostBinarySha256=digest(args.host),
                harnessSha256={
                    name: digest(HERE / name)
                    for name in ("smoke.py", "smoke.mjs", "wire.py")
                },
            )
            args.report.write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(dict(status="passed", checks=len(result["checksPassed"]))))
        finally:
            if "process" in locals() and process.returncode is None:
                if os.name == "nt":
                    cleanup = await asyncio.create_subprocess_exec(
                        "taskkill",
                        "/PID",
                        str(process.pid),
                        "/T",
                        "/F",
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    await cleanup.wait()
                else:
                    os.killpg(process.pid, signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except TimeoutError:
                    if os.name == "nt":
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            fixture.release.set()
            await fixture.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("host", "python", "adapter", "acp-source", "artifacts", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--payload", type=Path)
    args = parser.parse_args()
    args.report = args.report.absolute()
    for name in ("host", "adapter", "acp_source", "artifacts", "payload"):
        if getattr(args, name) is not None:
            setattr(args, name, getattr(args, name).resolve())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if not __debug__:
        raise RuntimeError("Qualification requires assertions")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
