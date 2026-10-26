"""Owned source host + installed ACP + actual public native, synthetic model."""

import argparse, asyncio, hashlib, json, os, signal, sqlite3, subprocess, sys, tempfile, time, urllib.request, urllib.error
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def http(port, path, method="GET", body=None, headers=None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read())
        except ValueError:
            result = {}
        return error.code, result


def listening_port(raw):
    # Only complete events from this launch may select the loopback endpoint.
    complete = raw.rsplit(b"\n", 1)[0] if b"\n" in raw else b""
    for line in complete.splitlines():
        if not line.startswith(b"AIONCORE_LISTENING "):
            continue
        try:
            if len(line) > 4096:
                raise ValueError
            value = json.loads(line[len(b"AIONCORE_LISTENING "):])
            if (set(value) != {"host", "port"} or value["host"] != "127.0.0.1"
                    or type(value["port"]) is not int or not 1 <= value["port"] <= 65535):
                raise ValueError
            return value["port"]
        except (ValueError, TypeError):
            raise RuntimeError("Invalid owned host listening event") from None
    return None


def startup_diagnostics(raw, returncode, phase):
    if phase not in {"initial_startup", "native_contract", "crash_restart", "original_operation_recovery", "authenticated_restart", "authentication_contract", "persistence_scan"}:
        phase = "unknown"
    if returncode is not None and type(returncode) is not int:
        returncode = None
    return dict(
        phase=phase,
        returncode=returncode,
        bindFailed=b"BOOTSTRAP_BIND_FAILED" in raw,
        peerAlreadyRunning=b"BOOTSTRAP_PEER_ALREADY_RUNNING" in raw,
        dataInitFailed=b"BOOTSTRAP_DATA_INIT_FAILED" in raw,
        serviceInitFailed=b"BOOTSTRAP_SERVICE_INIT_FAILED" in raw,
        listeningObserved=b"AIONCORE_LISTENING " in raw,
        readyObserved=b"AIONCORE_READY" in raw,
    )


def persistence_files(data_root):
    return sorted(file for file in data_root.rglob("*") if file.is_file()
                  and ("logs" in file.parts or file.name.startswith("aionui-backend.db")))


def removed_database_sidecars(before, after, databases):
    removed = before - after
    allowed = {Path(str(database) + suffix) for database in databases
               for suffix in ("-wal", "-shm", "-journal")}
    assert removed <= allowed, "Unscanned non-sidecar persistence file disappeared"
    return removed


def verify_live_database_snapshots(data_root, secret, timeout=5):
    databases = sorted(data_root.rglob("aionui-backend.db"))
    assert databases, "Owned host database snapshot target missing"
    deadline = time.monotonic() + timeout

    def progress(_status, _remaining, _total):
        if time.monotonic() >= deadline:
            raise TimeoutError("Owned host database snapshot deadline")

    # SQLite itself observes committed WAL state without reading mandatory
    # locked sidecar ranges as ordinary files. All connections close before
    # host shutdown; snapshots stay private and are never uploaded.
    with tempfile.TemporaryDirectory(prefix="studio16-private-db-snapshot-") as temporary:
        for index, database in enumerate(databases):
            snapshot = Path(temporary) / (str(index) + ".db")
            with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)) as source:
                with closing(sqlite3.connect(snapshot)) as destination:
                    source.backup(destination, pages=128, progress=progress, sleep=0.01)
            assert secret not in snapshot.read_bytes(), "Reverse payload persisted in live host database snapshot"
    return len(databases)


def observers(root, payload=None):
    facts = root / "wire-facts.jsonl"
    starts = root / "native-starts"
    entry = root / "observed-acp.py"
    entry.write_text(
        "import asyncio,json,os,sys\n"
        + (
            "sys.path.insert(0," + repr(str(payload.resolve() / "adapter-site")) + ")\n"
            if payload
            else ""
        )
        + """
from pathlib import Path
from aelix_acp import server
facts=Path(os.environ['OPERATION_FACTS'])
def note(value):
    with facts.open('a', encoding='utf-8') as stream: stream.write(json.dumps(value)+'\\n')
class Observed(server.Server):
    async def client_request(self,method,params):
        if method!='session/request_permission': return await super().client_request(method,params)
        permission=asyncio.create_task(super().client_request(method,params))
        await asyncio.sleep(.05)
        try:
            await asyncio.wait_for(super().client_request('_aelix/client_action',{'credential':'SYNTHETIC_REVERSE_SECRET'}),5)
            raise AssertionError('Unknown reverse action was accepted')
        except server.ProtocolError as error:
            assert 'unsupported_client_action' in str(error) and '-32601' in str(error)
            assert 'SYNTHETIC_REVERSE_SECRET' not in str(error)
            note({'reverseUnsupported':True})
        try:
            await asyncio.wait_for(super().client_request('session/request_permission', {
                'sessionId':params['sessionId'], 'toolCall':{'toolCallId':'malformed','title':'synthetic'},
                'options':[{'optionId':'malformed','name':'synthetic','kind':'SYNTHETIC_REVERSE_SECRET'}]}),5)
            raise AssertionError('Malformed typed request was accepted')
        except server.ProtocolError:
            note({'malformedTypedRejected':True})
        return await permission
    async def dispatch(self,method,params):
        operation=params.get('_meta',{}).get('aelix/operation') or params.get('operation')
        note({'method':method,'operation':operation})
        return await super().dispatch(method,params)
server.Server=Observed
server.main()
""",
        encoding="utf-8",
    )
    native = root / "observed-native.py"
    native.write_text(
        "import os\nfrom pathlib import Path\n"
        + f'with Path({str(starts)!r}).open("a", encoding="utf-8") as f:f.write(str(os.getpid())+"\\n")\n'
        + (
            "import sys,runpy\nsys.argv=["
            + repr(str(payload.resolve() / "launch.py"))
            + ',"native",*sys.argv[1:]]\nrunpy.run_path('
            + repr(str(payload.resolve() / "launch.py"))
            + ',run_name="__main__")\n'
            if payload
            else "from aelix_coding_agent.cli.entry import main_sync\nmain_sync()\n"
        ),
        encoding="utf-8",
    )
    return entry, native, facts, starts


async def run(args):
    ACP = args.acp_source.resolve()
    HOST = args.host.resolve()
    sys.path.insert(0, str(ACP / "scripts"))
    from qualify_permissions import ToolFixture
    from beta2_identity import verify
    from qualify_beta2 import adapter_receipt

    host_before = hashlib.sha256(HOST.read_bytes()).hexdigest()
    manifest = json.loads((ACP / "docs/beta2/manifest.json").read_text(encoding="utf-8"))
    wheels = args.artifacts.resolve()
    before = verify(manifest, wheels)
    installed = adapter_receipt(args.adapter.resolve())

    def payload_inventory():
        return (
            {
                file.relative_to(args.payload).as_posix(): (
                    "symlink:" + os.readlink(file)
                    if file.is_symlink()
                    else hashlib.sha256(file.read_bytes()).hexdigest()
                )
                for file in args.payload.rglob("*")
                if file.is_file() or file.is_symlink()
            }
            if args.payload
            else None
        )

    payload_before = payload_inventory()
    with tempfile.TemporaryDirectory(prefix="studio16-source-wire-") as temporary:
        root = Path(temporary).resolve()
        fixture = ToolFixture(root)
        await fixture.start()
        (root / "extensions").mkdir()
        entry, native, facts, starts = observers(root, args.payload)
        env = dict(
            fixture.env,
            OPERATION_FACTS=str(facts),
            AIONUI_DISABLE_AUTO_UPDATE="1",
            AIONUI_EXTENSIONS_PATH=str(root / "extensions"),
            AIONUI_EXTENSION_STATES_FILE=str(root / "extension-states.json"),
        )
        port, process = None, None
        phase = "initial_startup"
        startup_events = []
        launch_offset = 0
        log_path = root / "host.log"
        log = log_path.open("wb")

        async def launch(local=True):
            nonlocal port, process, launch_offset
            launch_offset = log_path.stat().st_size
            process = await asyncio.create_subprocess_exec(
                str(HOST),
                *(["--local"] if local else []),
                "--port",
                "0",
                "--data-dir",
                str(root / "host"),
                "--managed-resources-mode",
                "bundled",
                "--log-level",
                "info,agent_client_protocol::jsonrpc=trace",
                cwd=root / "workspace",
                env=env,
                stdout=log,
                stderr=log,
                **({"start_new_session": True} if os.name != "nt" else {}),
            )
            # Match the desktop launcher: let Core bind port 0 and consume its
            # actual listening event. The original state and operation fences
            # stay unchanged across restarts; HTTP port is not their identity.
            async with asyncio.timeout(30):
                while True:
                    raw = log_path.read_bytes()[launch_offset:]
                    selected = listening_port(raw)
                    if selected is not None:
                        port = selected
                        try:
                            code, _ = await asyncio.to_thread(http, port, "/api/assistants")
                            assert code == (200 if local else 401), "Unexpected owned host startup posture"
                            startup_events.append(startup_diagnostics(
                                log_path.read_bytes()[launch_offset:], process.returncode, phase))
                            return process
                        except OSError:
                            pass
                    if process.returncode is not None:
                        raise RuntimeError("Owned host exited during startup")
                    await asyncio.sleep(0.05)

        async def api(path, method="GET", body=None, expected=(200, 201, 202)):
            code, value = await asyncio.to_thread(http, port, path, method, body)
            assert code in expected, (path, code, value)
            return code, value.get("data", value)

        async def status(route, key):
            return (
                await api(
                    route
                    + "/operations/"
                    + key["id"]
                    + "?host_store_id="
                    + key["host_store_id"]
                )
            )[1]

        async def settled(route, key):
            async with asyncio.timeout(30):
                while True:
                    result = await status(route, key)
                    if result["state"] in (
                        "completed",
                        "cancelled",
                        "cancelled_before_dispatch",
                        "failed",
                        "interrupted",
                    ):
                        return result
                    await asyncio.sleep(0.02)

        checks = []
        try:
            process = await launch()
            phase = "native_contract"
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
                            str(args.payload.resolve() / "python"),
                        ],
                        check=True,
                        stdout=subprocess.DEVNULL,
                    )
                else:
                    alias.symlink_to(
                        args.payload.resolve() / "python", target_is_directory=True
                    )
                executable = alias / (
                    "python.exe" if os.name == "nt" else "bin/python3"
                )
                assert executable.samefile(args.python)
                python = str(executable)
            isolated = (
                ["-I", "-S", "-B", "-X", "utf8"] if args.payload else ["-I", "-B"]
            )
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
            await api(
                "/api/agents/custom",
                "POST",
                {
                    "name": "Studio16 managed synthetic",
                    "command": python,
                    "args": argv,
                    "env": [],
                    "icon": "🧪",
                },
            )
            assistants = (await api("/api/assistants"))[1]
            assistant = next(
                x for x in assistants if x["name"] == "Studio16 managed synthetic"
            )
            conv = (
                await api(
                    "/api/conversations",
                    "POST",
                    {
                        "name": "Studio16 operations",
                        "assistant": {"id": assistant["id"]},
                        "extra": {
                            "workspace": str(root / "workspace"),
                            "custom_workspace": True,
                        },
                    },
                )
            )[1]
            route = "/api/conversations/" + conv["id"]
            ready = (await api(route + "/runtime/ensure", "POST"))[1]
            cap = ready["operation_capability"]
            assert cap["schema"] == "aelix.operation/1", ready
            checks.append("actual_host_warmup_negotiates_adapter_and_host_store")
            key = dict(cap, id="host-operation-1")
            body = dict(content="SYNTHETIC_HOST_OPERATION", operation=key)
            code, admitted = await api(route + "/messages", "POST", body)
            assert code == 202 and admitted["operation"]["id"] == key["id"]
            terminal = await settled(route, key)
            assert terminal["state"] == "completed", terminal
            checks.append("actual_http_admission_metadata_native_prompt_and_terminal")
            count = len(fixture.requests)
            launches = starts.read_text(encoding="utf-8").splitlines()
            code, replay = await api(route + "/messages", "POST", body)
            assert (
                code == 200
                and replay["operation"]["replayed"]
                and (replay["msg_id"], replay["turn_id"])
                == (admitted["msg_id"], admitted["turn_id"])
            )
            assert (
                len(fixture.requests) == count
                and starts.read_text(encoding="utf-8").splitlines() == launches
            )
            checks.append(
                "completed_http_duplicate_preserves_ids_without_model_or_native_start"
            )
            code, conflict = await api(
                route + "/messages",
                "POST",
                dict(body, content="DIFFERENT"),
                expected=(409,),
            )
            assert conflict["code"] == "OPERATION_CONFLICT", conflict
            checks.append("http_same_key_different_body_structured_conflict")
            fixture.entered.clear()
            fixture.release.clear()
            hold = dict(cap, id="host-hold")
            holdbody = dict(content="QUALIFICATION_HOLD", operation=hold)
            _, accepted = await api(route + "/messages", "POST", holdbody)
            await asyncio.wait_for(fixture.entered.wait(), 15)
            _, duplicate = await api(route + "/messages", "POST", holdbody)
            assert (
                duplicate["msg_id"] == accepted["msg_id"]
                and len(fixture.requests) == count + 1
            )
            assert (await status(route, hold))["state"] == "pending"
            newkey = dict(cap, id="busy-other")
            await api(
                route + "/messages",
                "POST",
                dict(content="BUSY_OTHER", operation=newkey),
                expected=(409,),
            )
            assert (await status(route, newkey))["state"] == "not_found"
            checks.append(
                "pending_duplicate_precedes_busy_and_other_key_is_not_admitted"
            )
            _, stale = await api(route + "/cancel", "POST", dict(turn_id="stale-turn"))
            assert (
                stale["request_accepted"] is False
                and stale["runtime"]["turn_id"] == accepted["turn_id"]
            ), stale
            checks.append("stale_host_cancel_keeps_active_original_turn")
            _, cancel = await api(
                route + "/cancel", "POST", dict(turn_id=accepted["turn_id"])
            )
            assert cancel["request_accepted"] is True, cancel
            cancelled = await settled(route, hold)
            assert (
                cancelled["state"] == "cancelled"
                and cancelled["effects_unknown"] is True
            ), cancelled
            fixture.release.set()
            checks.append("scoped_http_cancel_waits_for_native_terminal")
            rows = [json.loads(line) for line in facts.read_text(encoding="utf-8").splitlines()]
            prompts = [r for r in rows if r["method"] == "session/prompt"]
            assert len(prompts) == 2 and all(
                r["operation"]["conversationId"] == conv["id"] for r in prompts
            )
            cancelled_wire = [r for r in rows if r["method"] == "session/cancel"]
            assert (
                len(cancelled_wire) == 1
                and cancelled_wire[0]["operation"]["turnId"] == accepted["turn_id"]
            ), cancelled_wire
            checks.append("actual_stdio_retains_original_schema_scope_and_cancel_fence")
            async with asyncio.timeout(5):
                while fixture.handlers:
                    await asyncio.sleep(0.01)
            target = root / "workspace/consent-write.txt"
            fixture.next_tool = ("write", {"path": str(target), "content": "synthetic"})
            consent = dict(cap, id="host-consent")
            _, consented = await api(
                route + "/messages",
                "POST",
                dict(content="SYNTHETIC_CONSENT", operation=consent),
            )
            async with asyncio.timeout(20):
                while not (await api(route + "/confirmations"))[1]:
                    await asyncio.sleep(0.02)
                while not any(
                    row.get("reverseUnsupported")
                    for row in map(json.loads, facts.read_text(encoding="utf-8").splitlines())
                ):
                    await asyncio.sleep(0.02)
                while not any(
                    row.get("malformedTypedRejected")
                    for row in map(json.loads, facts.read_text(encoding="utf-8").splitlines())
                ):
                    await asyncio.sleep(0.02)
            assert (
                not target.exists()
                and (await status(route, consent))["state"] == "pending"
            )
            await api(route + "/cancel", "POST", dict(turn_id=consented["turn_id"]))
            assert (await settled(route, consent))[
                "state"
            ] == "cancelled" and not target.exists()
            checks.extend(
                [
                    "unknown_reverse_request_finishes_while_typed_consent_pending",
                    "pending_consent_cancel_no_write_and_native_terminal",
                ]
            )
            await api(route + "/config-options/mode", "PUT", dict(value="yolo"))
            generation = dict(cap, id="host-generation")
            await api(
                route + "/messages",
                "POST",
                dict(content="SYNTHETIC_GENERATION", operation=generation),
            )
            assert (await settled(route, generation))["state"] == "completed"
            rows = list(map(json.loads, facts.read_text(encoding="utf-8").splitlines()))
            contexts = [
                row["operation"]
                for row in rows
                if row.get("method") == "session/prompt"
            ]
            assert contexts[-1]["generation"] != contexts[0]["generation"]
            checks.append(
                "actual_mode_restart_ack_refreshes_original_runtime_generation"
            )
            fixture.entered.clear()
            fixture.release.clear()
            crashed = dict(cap, id="host-crash")
            await api(
                route + "/messages",
                "POST",
                dict(content="QUALIFICATION_HOLD", operation=crashed),
            )
            await asyncio.wait_for(fixture.entered.wait(), 15)
            launches = starts.read_text(encoding="utf-8").splitlines()
            requests = len(fixture.requests)
            process.kill()
            await process.wait()
            fixture.release.set()
            phase = "crash_restart"
            process = await launch()
            phase = "original_operation_recovery"
            async with asyncio.timeout(20):
                while True:
                    recovered = await status(route, crashed)
                    if recovered["state"] != "recovery_waiting":
                        break
                    await asyncio.sleep(0.05)
            assert (
                recovered["state"]
                in ("completed", "interrupted", "failed", "cancelled")
                and recovered["automatic_retry"] is False
            ), recovered
            assert (
                starts.read_text(encoding="utf-8").splitlines() == launches
                and len(fixture.requests) == requests
            )
            checks.append(
                "hard_killed_host_restart_queries_original_status_without_native_start_or_replay"
            )
            _, duplicate = await api(
                route + "/messages",
                "POST",
                dict(content="QUALIFICATION_HOLD", operation=crashed),
            )
            assert (
                duplicate["operation"]["replayed"]
                and starts.read_text(encoding="utf-8").splitlines() == launches
            )
            checks.append("post_crash_duplicate_does_not_create_native_worker")
            assert "SYNTHETIC_REVERSE_SECRET" not in (root / "host.log").read_text(
                encoding="utf-8", errors="replace"
            )
            checks.append("reverse_secret_payload_absent_from_host_logs")
            # Reuse the exact host/state with its supported authenticated mode.
            # Desktop --local deliberately retains its existing default identity.
            process.terminate()
            await asyncio.wait_for(process.wait(), 10)
            provision = await asyncio.create_subprocess_exec(
                str(HOST),
                "--data-dir",
                str(root / "host"),
                "user",
                "create",
                "--username",
                "other-owner",
                "--password-stdin",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
            )
            await provision.communicate(b"Synthetic-Qualification-Password-123!\n")
            assert provision.returncode == 0
            phase = "authenticated_restart"
            process = await launch(local=False)
            phase = "authentication_contract"
            path = (
                route
                + "/operations/"
                + key["id"]
                + "?host_store_id="
                + key["host_store_id"]
            )
            assert (await asyncio.to_thread(http, port, path))[0] == 401
            assert (
                await asyncio.to_thread(
                    http, port, path, "GET", None, {"Authorization": "Bearer invalid"}
                )
            )[0] == 401
            code, login = await asyncio.to_thread(
                http,
                port,
                "/login",
                "POST",
                {
                    "username": "other-owner",
                    "password": "Synthetic-Qualification-Password-123!",
                    "remember": False,
                },
            )
            assert code == 200
            assert (
                await asyncio.to_thread(
                    http,
                    port,
                    path,
                    "GET",
                    None,
                    {"Authorization": "Bearer " + login["token"]},
                )
            )[0] == 404
            assert (
                await asyncio.to_thread(
                    http,
                    port,
                    route + "/messages",
                    "POST",
                    body,
                    {
                        "Cookie": "aionui-session=" + login["token"],
                        "Origin": "https://foreign.invalid",
                    },
                )
            )[0] == 403
            assert (
                starts.read_text(encoding="utf-8").splitlines() == launches
                and len(fixture.requests) == requests
            )
            checks.extend(
                [
                    "authenticated_status_requires_valid_session_and_original_owner",
                    "foreign_origin_cookie_mutation_without_csrf_is_rejected_before_admission",
                ]
            )
            phase = "persistence_scan"
            secret = b"SYNTHETIC_REVERSE_SECRET"
            before_shutdown = set(persistence_files(root / "host"))
            databases = set((root / "host").rglob("aionui-backend.db"))
            snapshot_count = verify_live_database_snapshots(root / "host", secret)
            # Release live SQLite/file locks before the raw byte scan. This is
            # the existing bounded host stop, with no skipped unreadable files.
            process.terminate()
            await asyncio.wait_for(process.wait(), 10)
            after_shutdown = set(persistence_files(root / "host"))
            removed_sidecars = removed_database_sidecars(before_shutdown, after_shutdown, databases)
            assert after_shutdown, "Owned host persistence scan target missing"
            for file in after_shutdown:
                assert secret not in file.read_bytes(), "Reverse payload persisted in quiescent host log/DB"
            assert secret not in log_path.read_bytes(), "Reverse payload persisted in host stdout log"
            checks.append(
                "malformed_typed_request_and_sdk_warn_payload_absent_from_host_logs_and_committed_database"
            )
            assert [event["phase"] for event in startup_events] == [
                "initial_startup", "crash_restart", "authenticated_restart"]
            assert all(event["listeningObserved"] and event["readyObserved"] for event in startup_events)
            report = dict(
                status="passed",
                scope="actual host HTTP/stdio + installed ACP + public native; synthetic provider; UI separate",
                installer=args.payload is not None,
                checksPassed=checks,
                providerRequests=len(fixture.requests),
                hostBinarySha256=hashlib.sha256(HOST.read_bytes()).hexdigest(),
                nativePatches=[],
                startupEvents=startup_events,
                liveDatabaseSnapshots=snapshot_count,
                persistenceFilesBeforeShutdown=len(before_shutdown),
                persistenceFilesAfterShutdown=len(after_shutdown),
                sidecarsRemovedDuringShutdown=len(removed_sidecars),
                quiescentPersistenceScan=process.returncode is not None,
                harnessSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            )
        except BaseException as error:
            raw = log_path.read_bytes()
            args.report.with_name("host-failure.local").write_bytes(raw)
            failure_kind = type(error).__name__
            if failure_kind not in {"TimeoutError", "AssertionError", "RuntimeError", "OSError", "CancelledError"}:
                failure_kind = "Other"
            # Uploaded diagnostics are fixed enums/booleans and an exit code,
            # never raw logs, argv, endpoints, request payloads or exceptions.
            args.report.write_text(json.dumps(dict(
                status="failed", checksPassed=checks, failureKind=failure_kind,
                startup=startup_diagnostics(raw[launch_offset:], process.returncode if process else None, phase),
                startupEvents=startup_events,
                nativePatches=[], harnessSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            ), indent=2) + "\n", encoding="utf-8")
            raise
        finally:
            fixture.release.set()
            if process is not None and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 10)
                except TimeoutError:
                    if os.name == "nt":
                        process.kill()
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            log.close()
            await fixture.close()
    assert host_before == hashlib.sha256(HOST.read_bytes()).hexdigest()
    assert before == verify(manifest, wheels) and installed == adapter_receipt(
        args.adapter.resolve()
    )
    assert payload_before == payload_inventory(), (
        "Installed payload changed during actual host wire qualification"
    )
    report.update(
        nativeMembers=309,
        nativeIdentityUnchanged=True,
        installedAdapterIdentityUnchanged=True,
        installedPayloadUnchanged=args.payload is not None,
        installedPayloadFiles=len(payload_before)
        if payload_before is not None
        else None,
    )
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("host", "python", "adapter", "acp-source", "artifacts", "report"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--payload", type=Path)
    args = parser.parse_args()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if not __debug__:
        raise RuntimeError("Qualification requires assertions")
    args.report.write_text(json.dumps(dict(status="running", nativePatches=[])) + "\n", encoding="utf-8")
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
