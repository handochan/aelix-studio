/** Studio-owned sessionless host. Executed by the unchanged public native wheel's Python. */
export const NATIVE_AUTH_HELPER = String.raw`
import asyncio
import contextlib
import dataclasses
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import uuid
from urllib.parse import urlsplit

wire = sys.stdout

def send(frame):
    wire.write(json.dumps(frame) + "\n")
    wire.flush()

class Refused(Exception):
    pass

def text(value, limit=256):
    if not isinstance(value, str) or not value or len(value) > limit or any(ord(c) < 32 for c in value):
        raise Refused("INVALID_INPUT")
    return value

def provider_id(value):
    value = text(value, 100)
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", value):
        raise Refused("INVALID_INPUT")
    return value

async def main():
    from aelix_ai.oauth.auth_storage import AuthStorage
    from aelix_ai.oauth._registry import get_oauth_providers, get_oauth_provider
    from aelix_ai.oauth.types import OAuthLoginCallbacks
    from aelix_coding_agent.cli.config import get_agent_dir
    from aelix_coding_agent.model_registry import ModelRegistry
    from aelix_coding_agent.models_json import strip_json_comments, validate_models_config, validate_config_semantics

    # Anonymous stdin pipes are not connect_read_pipe transports on Windows.
    # A daemon owns blocking reads; a bounded queue applies backpressure without
    # leaving a default-executor thread that prevents cancellation/EOF shutdown.
    loop = asyncio.get_running_loop()
    input_lines = asyncio.Queue(maxsize=2)
    input_stopped = threading.Event()
    asyncio.current_task().add_done_callback(lambda _task: input_stopped.set())
    def deliver(line):
        if input_stopped.is_set():
            return False
        delivery = input_lines.put(line)
        try:
            future = asyncio.run_coroutine_threadsafe(delivery, loop)
        except RuntimeError:
            delivery.close()
            return False
        while not input_stopped.is_set():
            try:
                future.result(timeout=0.2)
                return True
            except TimeoutError:
                continue
            except Exception:
                return False
        future.cancel()
        return False
    def read_input():
        try:
            fd = sys.stdin.fileno()
            if sys.platform == "win32":
                import msvcrt
                msvcrt.setmode(fd, os.O_BINARY)
            buffer = b""
            while not input_stopped.is_set():
                # Raw fd reads avoid the BufferedReader lock during CPython's
                # Windows daemon-thread finalization (including OAuth success).
                chunk = os.read(fd, 4096)
                if not chunk:
                    if buffer:
                        deliver(buffer)
                    deliver(b"")
                    return
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if len(line) > 65535:
                        deliver(b"x" * 65537)
                        return
                    if not deliver(line + b"\n"):
                        return
                if len(buffer) > 65536:
                    deliver(b"x" * 65537)
                    return
        except (OSError, RuntimeError):
            deliver(b"")
    input_thread = threading.Thread(target=read_input, daemon=True)
    input_thread.start()
    async def read():
        line = await input_lines.get()
        if not line:
            raise Refused("CANCELLED")
        if len(line) > 65536:
            raise Refused("INVALID_INPUT")
        return json.loads(line)

    args = await read()
    action = args.get("action")
    root = Path(get_agent_dir()).expanduser().resolve()
    auth_path, models_path = root / "auth.json", root / "models.json"
    def verify_private_files():
        pass
    if sys.platform == "win32" and (action not in ("catalog", "select") or not root.exists()):
        if action not in ("catalog", "select") and args.get("exclusive") is not True:
            raise Refused("EXCLUSIVE_REQUIRED")
        # Windows chmod does not establish credential confidentiality. New
        # roots receive a protected user/system/admin DACL; an existing shared
        # root is refused instead of changing unrelated operator permissions.
        import win32api
        import win32con
        import win32security
        token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
        try:
            owner = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
        finally:
            token.Close()
        trusted = {win32security.ConvertSidToStringSid(owner), "S-1-5-18", "S-1-5-32-544", "S-1-3-0", "S-1-3-4"}
        if not root.exists():
            root.mkdir(parents=True)
            acl = win32security.ACL()
            for sid in (owner, win32security.ConvertStringSidToSid("S-1-5-18"), win32security.ConvertStringSidToSid("S-1-5-32-544")):
                acl.AddAccessAllowedAceEx(win32security.ACL_REVISION_DS, 3, 0x1F01FF, sid)
            win32security.SetNamedSecurityInfo(str(root), win32security.SE_FILE_OBJECT,
                win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
                None, None, acl, None)
        def verify_private_files():
            for protected in (root, auth_path, root / "auth.json.tmp", models_path, root / ".studio-auth.lock"):
                if not protected.exists():
                    continue
                descriptor = win32security.GetNamedSecurityInfo(str(protected), win32security.SE_FILE_OBJECT,
                    win32security.DACL_SECURITY_INFORMATION | win32security.OWNER_SECURITY_INFORMATION)
                # An untrusted owner can replace the DACL regardless of its
                # current entries. CREATOR_OWNER does not establish ownership.
                if win32security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()) not in trusted - {"S-1-3-0", "S-1-3-4"}:
                    raise Refused("PRIVATE_DIRECTORY_REQUIRED")
                acl = descriptor.GetSecurityDescriptorDacl()
                if acl is None:
                    raise Refused("PRIVATE_DIRECTORY_REQUIRED")
                for index in range(acl.GetAceCount()):
                    ace = acl.GetAce(index)
                    if ace[0][0] not in (0, 1, 5, 6):
                        raise Refused("PRIVATE_DIRECTORY_REQUIRED")
                    if ace[0][0] in (0, 5) and ace[1] & 0xD00D0047:
                        if win32security.ConvertSidToStringSid(ace[-1]) not in trusted:
                            raise Refused("PRIVATE_DIRECTORY_REQUIRED")
        verify_private_files()

    def revision():
        # File metadata only: never hash credentials into a receipt/operation ledger.
        parts = []
        for path in (auth_path, models_path):
            if path.exists():
                st = path.stat()
                parts.append([st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size])
            else:
                parts.append(None)
        return json.dumps(parts, separators=(",", ":"))

    # The public library treats corrupt/unreadable auth JSON as empty. Refuse
    # before calling it so registration cannot silently replace operator credentials.
    if auth_path.exists():
        try:
            raw = auth_path.read_text(encoding="utf-8")
            parsed_auth = json.loads(raw) if raw.strip() else {}
            if not isinstance(parsed_auth, dict) or any(not isinstance(value, dict) for value in parsed_auth.values()):
                raise ValueError()
        except Exception:
            raise Refused("INVALID_CONFIG")
    storage = AuthStorage(auth_path)  # Public CLI's explicit path, NOT AuthStorage().
    await storage.load()
    if storage.drain_errors():
        raise Refused("INVALID_CONFIG")
    registry = ModelRegistry.create(storage, str(models_path))
    if registry.get_error():
        raise Refused("INVALID_CONFIG")

    async def catalog():
        oauth = {p.id: p.name for p in get_oauth_providers()}
        models = registry.get_all()
        ids = sorted({m.provider for m in models} | set(storage.list()) | set(oauth))
        result = []
        def model_info(model):
            parsed = urlsplit(model.base_url)
            # Existing operator configs may have URL secrets. Never project them into diagnostics/UI.
            host = parsed.hostname or ""
            endpoint = parsed.scheme + "://" + ("[" + host + "]" if ":" in host else host)
            if parsed.port:
                endpoint += ":" + str(parsed.port)
            endpoint += parsed.path
            return dict(id=model.id, name=model.name, endpoint=endpoint, api=model.api)
        for pid in ids:
            status = await registry.get_provider_auth_status(pid)
            result.append(dict(id=pid, name=oauth.get(pid, registry.get_provider_display_name(pid)),
                               configured=status.configured, source=status.source, oauth=pid in oauth,
                               models=[model_info(m) for m in models if m.provider == pid]))
        return dict(root=str(root), authPath=str(auth_path), modelsPath=str(models_path),
                    revision=revision(), providers=result, concurrentLegacyMutation=False, appliesAt="new_session")

    if action == "catalog":
        return await catalog()
    pid = provider_id(args.get("provider"))
    if action == "select":
        if registry.find(pid, text(args.get("model"))) is None:
            raise Refused("UNSUPPORTED_MODEL")
        return dict(root=str(root))
    if action not in ("setKey", "logout", "login", "endpoint"):
        raise Refused("UNSUPPORTED")
    if args.get("exclusive") is not True:
        raise Refused("EXCLUSIVE_REQUIRED")
    if args.get("revision") != revision():
        raise Refused("CONFLICT")
    # Stable sidecar serializes cooperating Studio helpers. Legacy CLI does not
    # participate: exclusive operator use remains required, including on POSIX.
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_file = open(root / ".studio-auth.lock", "a+b")
    try:
        if sys.platform == "win32":
            import msvcrt
            if lock_file.seek(0, 2) == 0:
                lock_file.write(b"\0")
                lock_file.flush()
            lock_file.seek(0)
            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (BlockingIOError, PermissionError):
        raise Refused("BUSY")
    if args.get("revision") != revision():
        raise Refused("CONFLICT")
    if action != "endpoint" and pid not in {p["id"] for p in (await catalog())["providers"]}:
        raise Refused("UNSUPPORTED_PROVIDER")

    if action == "setKey":
        key = text(args.get("key"), 16384).strip()
        if not key or key.startswith("!"):
            raise Refused("INVALID_INPUT")
        await storage.set_api_key(pid, key)
    elif action == "logout":
        await storage.logout(pid)
    elif action == "endpoint":
        endpoint = text(args.get("endpoint"), 2048)
        parsed = urlsplit(endpoint)
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise Refused("INVALID_ENDPOINT")
        api = args.get("api")
        if api not in ("openai-completions", "anthropic-messages"):
            raise Refused("UNSUPPORTED")
        model = text(args.get("model"))
        config = json.loads(strip_json_comments(models_path.read_text(encoding="utf-8"))) if models_path.exists() else {"providers": {}}
        providers = config.setdefault("providers", {})
        existing = providers.get(pid, {})
        # Preserve operator-owned auth/headers/model overrides; add only a missing model and explicit endpoint.
        updated = dict(existing, baseUrl=endpoint, api=api)
        definitions = list(existing.get("models", []))
        if model not in {m["id"] for m in definitions}:
            definitions.append(dict(id=model, name=model))
        updated["models"] = definitions
        providers[pid] = updated
        if validate_models_config(config) or validate_config_semantics(config):
            raise Refused("INVALID_CONFIG")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(prefix=".studio-models-", dir=root)
        try:
            with os.fdopen(fd, "w") as output:
                json.dump(config, output, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            if args.get("revision") != revision():
                raise Refused("CONFLICT")
            os.replace(temporary, models_path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    else:
        oauth = get_oauth_provider(pid)
        if oauth is None:
            raise Refused("UNSUPPORTED")
        original_revision = revision()
        responses = asyncio.Queue()
        input_closed = asyncio.Event()
        async def pump_input():
            try:
                while True:
                    await responses.put(await read())
            except Exception:
                input_closed.set()
                await responses.put(None)
        async def on_auth(info):
            send(dict(event="authorization", url=info.url, instructions=info.instructions))
        async def prompt(message, allow_empty=False, options=None, kind=None):
            challenge = uuid.uuid4().hex
            send(dict(event="prompt", challengeId=challenge, message=message, allowEmpty=allow_empty, options=options, kind=kind))
            frame = await responses.get()
            if frame is None:
                raise Refused("CANCELLED")
            if frame.get("challengeId") != challenge:
                raise Refused("STALE_CHALLENGE")
            value = frame.get("value")
            if not isinstance(value, str) or len(value) > 16384 or (not value and not allow_empty):
                raise Refused("INVALID_INPUT")
            if options is not None and value not in {o["id"] for o in options}:
                raise Refused("INVALID_INPUT")
            return value
        async def on_prompt(info):
            return await prompt(info.message, info.allow_empty)
        async def on_manual():
            return await prompt("", kind="manual")
        async def on_select(info):
            return await prompt(info.message, options=[dataclasses.asdict(o) for o in info.options])
        # Obtain credentials through native callbacks; commit only after a fresh revision check.
        # Do not use AuthStorage.login(): it commits before we can detect a concurrent external edit.
        pump = asyncio.create_task(pump_input())
        closed = asyncio.create_task(input_closed.wait())
        login = asyncio.create_task(oauth.login(OAuthLoginCallbacks(on_auth=on_auth, on_prompt=on_prompt,
                                                                  on_manual_code_input=on_manual, on_select=on_select)))
        try:
            await asyncio.wait((login, closed), return_when=asyncio.FIRST_COMPLETED)
            if input_closed.is_set():
                raise Refused("CANCELLED")
            credentials = await login
        finally:
            for task in (pump, closed, login):
                if not task.done():
                    task.cancel()
            await asyncio.gather(pump, closed, login, return_exceptions=True)
        if revision() != original_revision:
            raise Refused("CONFLICT")
        verify_private_files()
        await storage.set_oauth(pid, credentials)
    verify_private_files()
    await storage.load()
    if storage.drain_errors():
        raise Refused("NATIVE_FAILED")
    registry.refresh()
    return await catalog()

try:
    # Native diagnostics must never reach the protocol, app log, transcript or telemetry.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        result = asyncio.run(main())
    send(dict(result=result))
except Refused as error:
    send(dict(error=str(error)))
except BaseException:
    send(dict(error="NATIVE_FAILED"))
`;
