/** A single request in the selected runtime's embedded Python. Only native offline APIs are imported. */
export const NATIVE_RESOURCES_HELPER = String.raw`
import asyncio
import contextlib
import hashlib
import hmac
import io
import json
import os
import stat
import sys
import threading
from pathlib import Path
from urllib.parse import quote

ROOT = Path(os.environ["AELIX_CODING_AGENT_DIR"])
CWD = os.getcwd()
SEED = bytes.fromhex(os.environ["STUDIO_RESOURCES_REVISION_KEY"])
HOME = Path.home()
STORE_BYTES = 1024 * 1024
MARKDOWN_BYTES = 128 * 1024
DISCOVERY_BYTES = 8 * 1024 * 1024
CATALOG_BYTES = 16 * 1024 * 1024
DISCOVERY_ENTRIES = 2048
SELECTION_ENTRIES = 1024

class Refusal(Exception):
    def __init__(self, code, **detail):
        self.reply = dict(ok=False, code=code, **detail)

AUTH_PATHS = [
    ROOT / "auth.json", HOME / ".aelix/agent/auth.json", HOME / ".config/aelix/agent/auth.json",
    Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config") / "aelix/agent/auth.json",
]
if os.environ.get("AELIX_AUTH_PATH"):
    AUTH_PATHS.append(Path(os.environ["AELIX_AUTH_PATH"]))
AUTH_NAMES = {path.resolve() for path in AUTH_PATHS}

def identity(info):
    return info.st_dev, info.st_ino

def file_info(path):
    try:
        return path.stat()
    except FileNotFoundError:
        return None

def credential_identities():
    return {identity(info) for name in AUTH_PATHS if (info := file_info(name)) is not None}

STARTUP_CREDENTIALS = credential_identities()

def credential(info):
    return info is not None and (identity(info) in STARTUP_CREDENTIALS or
        (info.st_nlink > 1 and identity(info) in credential_identities()))

def protect_native_io(event, args):
    if event in ("subprocess.Popen", "os.posix_spawn", "os.system", "os.exec", "os.spawn", "os.fork"):
        raise Refusal("HELPER_UNAVAILABLE")
    if event == "open" and isinstance(args[0], (str, bytes)):
        real = Path(os.fsdecode(args[0])).resolve()
        info = file_info(real) if STARTUP_CREDENTIALS else None
        if real in AUTH_NAMES or (info is not None and identity(info) in STARTUP_CREDENTIALS):
            raise PermissionError("credential store is outside native resource discovery")

# Native discovery follows links. Recheck credential identities at each open.
sys.addaudithook(protect_native_io)
with contextlib.redirect_stdout(sys.stderr):
    from aelix_ai.settings.settings_manager import Settings, SettingsManager, SettingsFileError
    from aelix_ai.settings.storage import FileSettingsStorage
    from aelix_coding_agent.agents.discovery import builtin_agents_dir, complete_profile, discover_profiles, ProfileDiscoveryResult, ProfileError
    from aelix_coding_agent.agents.profile import parse_profile
    from aelix_coding_agent.cli.config import packaged_skills_dir
    from aelix_coding_agent.core import mcp_config_edit as mcp_writer
    from aelix_coding_agent.core.mcp_selection import McpSelection, McpKind
    from aelix_coding_agent.core.resource_filter import ScopeList
    from aelix_coding_agent.core.resource_selection import ResourceItem, SettingsLists, grammar_of
    from aelix_coding_agent.core.skill_dirs import user_agents_skills_dir
    from aelix_coding_agent.core.skill_selection import SkillSource, load_skill_catalog
    from aelix_coding_agent.core.tool_selection import DefaultToolsGrammar, EditRefused
    from aelix_coding_agent.tools import ALL_TOOL_NAMES

# Native APIs above are bound before dispatch.
def diagnostic(code, key=None, source=None):
    return dict(code=code, key=key, source=source)

def resolve_entry(path):
    """Resolve an existing entry or an ordinary missing suffix; reject dangling links."""
    try:
        return path.resolve(strict=True)
    except FileNotFoundError:
        if path != path.parent:
            try:
                path.lstat()
            except FileNotFoundError:
                return resolve_entry(path.parent) / path.name
        raise Refusal("STORE_UNREADABLE") from None
    except (OSError, RuntimeError):
        raise Refusal("STORE_UNREADABLE") from None

def admit_store(path, anchor):
    real = resolve_entry(path)
    root = resolve_entry(anchor)
    try:
        info = file_info(real)
    except OSError:
        raise Refusal("STORE_UNREADABLE") from None
    if (real == root or not real.is_relative_to(root) or real in AUTH_NAMES or
            (info is not None and (not stat.S_ISREG(info.st_mode) or credential(info)))):
        raise Refusal("STORE_UNREADABLE")
    return real

def bounded_read(stream, info, limit):
    if not stat.S_ISREG(info.st_mode) or credential(info):
        raise PermissionError("file outside native resource discovery")
    if info.st_size > limit:
        raise Refusal("RESULT_TOO_LARGE")
    data = stream.read(limit + 1)
    if len(data) > limit:
        raise Refusal("RESULT_TOO_LARGE")
    return data

def raw_file(path, limit=STORE_BYTES, follow=True):
    try:
        real = path.resolve(strict=True) if follow else path
        before = real.lstat()
    except FileNotFoundError:
        return None, None
    if not stat.S_ISREG(before.st_mode) or credential(before):
        raise PermissionError("file outside native resource discovery")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(real, flags), "rb") as stream:
        info = os.fstat(stream.fileno())
        if identity(info) != identity(before):
            raise Refusal("STORE_UNREADABLE")
        return bounded_read(stream, info, limit), info

@contextlib.contextmanager
def bounded_discovery(limit=MARKDOWN_BYTES, store=None):
    """Meter the native scanners' actual directory iteration and file reads."""
    iterdir, read_bytes, read_text = Path.iterdir, Path.read_bytes, Path.read_text
    scanned, total = 0, 0

    def entries(directory):
        nonlocal scanned
        with os.scandir(directory) as children:
            for child in children:
                scanned += 1
                if scanned > DISCOVERY_ENTRIES:
                    raise Refusal("RESULT_TOO_LARGE")
                yield directory / child.name

    def content(path):
        nonlocal total
        if store is not None and resolve_entry(path) != store:
            raise Refusal("STORE_UNREADABLE")
        data, _ = raw_file(store or path, min(limit, DISCOVERY_BYTES - total), follow=store is None)
        if data is None:
            raise FileNotFoundError
        total += len(data)
        return data

    def text(path, encoding=None, errors=None, newline=None):
        value = content(path).decode(encoding or "utf-8", errors or "strict")
        return value.replace("\r\n", "\n").replace("\r", "\n") if newline is None else value

    try:
        Path.iterdir, Path.read_bytes, Path.read_text = entries, content, text
        yield content
    finally:
        Path.iterdir, Path.read_bytes, Path.read_text = iterdir, read_bytes, read_text

def read_mcp_fd(fd):
    with os.fdopen(fd, "rb", closefd=False) as stream:
        return bounded_read(stream, os.fstat(fd), STORE_BYTES)

# The pinned writer also rechecks the saved bytes immediately before replacement.
mcp_writer._read_all = read_mcp_fd

def store_version(real, source):
    try:
        data, info = raw_file(real, follow=False)
    except OSError:
        raise Refusal("STORE_UNREADABLE") from None
    return data, revision_for(real, source, data, info)

def revision_for(real, source, data, info):
    mac = hmac.new(SEED, digestmod=hashlib.sha256)
    # Include file identity as well as bytes so replacement and ABA edits stale old tokens.
    version = None if info is None else (info.st_dev, info.st_ino, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)
    mac.update(json.dumps([source, str(real), version]).encode())
    if data is not None:
        mac.update(data)
    return "g." + mac.hexdigest()

def check_revision(command, current):
    if not hmac.compare_digest(command["expectedRevision"].encode(), current.encode()):
        raise Refusal("REVISION_CONFLICT", currentRevision=current)

def display_name(name):
    return quote(name, safe=" ", errors="replace") if name else "%2F"

def safe_int(value):
    return value if value is not None and 0 <= value < 2**53 else None

def profiles(command, content):
    discovered = discover_profiles(CWD, project_trusted=False, agent_dir=str(ROOT))
    dirs = {"user": ROOT / "agents", "bundled": builtin_agents_dir()}

    def source(path, scope):
        return scope + ":agents/" + display_name(Path(path).name)

    diagnostics = []
    for item in discovered.diagnostics:
        path = Path(item.path)
        scope = next((tier for tier, directory in dirs.items() if path.parent == directory), None)
        code = "invalid-profile" if item.type == "error" else item.code.replace("_", "-")
        diagnostics.append(diagnostic(code, source=source(path, scope) if scope else None))
    rows = []
    name = command.get("name")
    for original in discovered.profiles:
        if name is not None and name != original.name:
            continue
        path = Path(original.file_path)
        try:
            actual = path.resolve(strict=True)
            raw = content(actual)
            text = text_of(raw)
        except (OSError, UnicodeError):
            diagnostics.append(diagnostic("invalid-profile", source=source(path, original.scope)))
            continue
        # Bind the public ref and the preview to the same bytes even if the discovery read raced an edit.
        result = parse_profile(text, file_path=str(path), scope=original.scope)
        parsed = result.profile
        if parsed is None or parsed.name != original.name:
            diagnostics.append(diagnostic("invalid-profile", source=source(path, original.scope)))
            continue
        prefix = "\0".join(("studio-profile/1", parsed.scope, actual.as_uri(), "")).encode()
        ref = dict(name=parsed.name, scope=parsed.scope, revision="sha256:" + hashlib.sha256(prefix + raw).hexdigest())
        if name is None:
            rows.append(dict(ref=ref, description=parsed.description))
            continue
        try:
            complete_profile(parsed, ProfileDiscoveryResult([parsed], result.diagnostics))
        except ProfileError:
            break
        def paths(values):
            items = (Path(value) for value in values)
            return [
                "/".join(display_name(part) for part in item.relative_to(path.parent).parts)
                if item.is_relative_to(path.parent) and item != path.parent else display_name(item.name)
                for item in items
            ]
        prompt = parsed.body.encode()[:8192].decode("utf-8", errors="ignore")
        return dict(profile=dict(
            ref=ref, source=source(path, parsed.scope), description=parsed.description,
            promptMode=parsed.system_prompt, promptPreview=prompt, promptTruncated=prompt != parsed.body,
            provider=parsed.provider, model=parsed.model, tools=parsed.tools, skills=paths(parsed.skills),
            approvalMode=parsed.approval_mode,
            policy=dict(builtinTools=parsed.builtin_tools, excludeTools=parsed.exclude_tools,
                inheritSkills=parsed.inherit_skills, extensions=paths(parsed.extensions),
                inheritExtensions=parsed.inherit_extensions, contextFiles=parsed.context_files,
                thinking=parsed.thinking, role=parsed.role, outputCap=safe_int(parsed.output_cap),
                timeoutMs=safe_int(parsed.timeout_ms), agents=parsed.agents)))
    if name is not None:
        raise Refusal("PROFILE_UNAVAILABLE")
    return dict(profiles=rows, diagnostics=diagnostics, nextCursor=None)

def row(key, label, saved, decided, role="item", lock=None, problem=None):
    return dict(key=key, label=label, role=role, saved=saved, decidedBy=decided, lock=lock, problem=problem)

def listing(kind, revision, exists, rows, diagnostics, reason=None):
    return dict(scope="global", kind=kind, effect="restart" if kind == "mcp" else "next_request",
        revision=revision, writable=reason is None, reason=reason, exists=exists,
        items=rows, diagnostics=diagnostics, nextCursor=None)

def edits_for(command, rows):
    by_key = {r["key"]: r for r in rows}
    edits = []
    for change in command["changes"]:
        key, want = change["key"], change["on"]
        if key not in by_key:
            raise Refusal("SELECTION_MISSING", key=key)
        old = by_key[key]
        if old["lock"] is not None or old["role"] != "item":
            raise Refusal("SELECTION_LOCKED", key=key)
        if old["saved"] != want:
            edits.append((key, want))
    return edits

def saved(command, revision, before, after):
    old = {r["key"]: r["saved"] for r in before}
    new = {r["key"]: r["saved"] for r in after}
    return dict(scope="global", kind=command["kind"], revision=revision, saved=True, appliesAt="next_worker",
        changed=[dict(key=key, saved=on) for key, on in new.items() if key in old and old[key] != on],
        mismatches=[dict(key=c["key"], reason="saved-value-differs") for c in command["changes"]
                    if new.get(c["key"]) != c["on"]])

def text_of(raw):
    return raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") if raw is not None else None

class GuardedSettings(FileSettingsStorage):
    """Use edit_list's native transaction and capture the exact, locked revisions."""
    def __init__(self, path, anchor, guard):
        super().__init__(CWD, ROOT, global_path=path)
        self.anchor = anchor
        self.guard = guard
        self.committed = False
        self.revision = None
        self.locked = None

    def selection(self):
        return admit_store(self.global_path, self.anchor)

    def target(self, scope):
        return self.locked if self.locked is not None else super().target(scope)

    @contextlib.contextmanager
    def _sidecar_lock(self, path):
        # Native keys the sidecar to the target but puts it beside the configured entry.
        sidecar = self._sidecar_path(path)
        parent = resolve_entry(self.global_path.parent)
        real = admit_store(sidecar, self.global_path.parent)
        info = file_info(real)
        if real != parent / "locks" / sidecar.name or (info is not None and info.st_nlink != 1):
            raise Refusal("STORE_UNREADABLE")
        with super()._sidecar_lock(path):
            self.check_target(path)
            yield

    def check_target(self, path):
        current = self.selection()
        if current != path:
            raise Refusal("REVISION_CONFLICT", currentRevision=store_version(current, "settings")[1])

    def _read_text_strict(self, path):
        return text_of(raw_file(path, follow=False)[0])

    def transact(self, scope, build):
        self.locked = self.selection()
        def checked(current):
            self.check_target(self.locked)
            raw, current_revision = store_version(self.locked, "settings")
            if text_of(raw) != current:
                raise Refusal("REVISION_CONFLICT", currentRevision=current_revision)
            self.revision = current_revision
            self.guard(current, current_revision)
            return build(current)
        try:
            super().transact(scope, checked)
        finally:
            self.locked = None

    def _write_text_atomic(self, path, payload):
        self.check_target(path)
        if len(payload.encode("utf-8")) > STORE_BYTES:
            raise Refusal("RESULT_TOO_LARGE")
        try:
            super()._write_text_atomic(path, payload)
        except OSError:
            raise Refusal("SAVE_FAILED") from None
        self.committed = True
        data, self.revision = store_version(path, "settings")
        if self.selection() != path or data != payload.encode("utf-8"):
            raise Refusal("OUTCOME_UNKNOWN", retryable=False)

def writable_store(target):
    parent = next((ancestor for ancestor in target.parents if ancestor.exists()), target.parent)
    if not parent.is_dir() or not parent.stat().st_mode & stat.S_IWUSR or not os.access(parent, os.W_OK | os.X_OK):
        return False
    return not target.is_file() or (bool(target.stat().st_mode & stat.S_IWUSR) and os.access(target, os.W_OK))

def settings(command):
    kind = command["kind"]
    key = "defaultTools" if kind == "tool" else "skills"
    override = os.environ.get("AELIX_SETTINGS_PATH")
    path = Path(override) if override else ROOT / "settings.json"
    anchor = path.parent if override else ROOT
    base = str(path.parent)
    grammar = DefaultToolsGrammar(ALL_TOOL_NAMES) if kind == "tool" else grammar_of(None)
    mutation = command["action"] == "selections/set"
    wanted, before, after = [], [], []
    items = {}
    candidates, diagnostics = [], []

    def view(entries):
        nonlocal candidates, diagnostics
        if isinstance(entries, list) and len(entries) > SELECTION_ENTRIES:
            raise Refusal("RESULT_TOO_LARGE")
        valid, problems = grammar.validate(entries)
        selections = ScopeList("global", tuple(valid or ()), base, present=valid is not None)
        if not candidates:
            diagnostics = [diagnostic("invalid-settings-entry")] if problems else []
        if not candidates and kind == "tool":
            candidates = [ResourceItem(kind=kind, key=name, label=name, identities=(name,)) for name in sorted(ALL_TOOL_NAMES)]
        elif not candidates:
            with bounded_discovery():
                catalog = load_skill_catalog([
                    SkillSource("global", str(ROOT / "skills")),
                    SkillSource("global", str(user_agents_skills_dir()), agents=True),
                    SkillSource("bundled", str(packaged_skills_dir())),
                ], SettingsLists(selections))
            candidates = [ResourceItem(kind=kind, key=s.name, label=s.name, identities=(s.name,),
                path=s.file_path, scope=catalog.origins[s.file_path].tier,
                source_base=catalog.origins[s.file_path].directory) for s in catalog.discovered]
            if catalog.problems:
                diagnostics.append(diagnostic("skill-settings-problem"))
            if catalog.diagnostics:
                diagnostics.append(diagnostic("invalid-skill"))
            if catalog.shadowed:
                diagnostics.append(diagnostic("shadowed-skill"))
        values = grammar.evaluate_all(candidates, selections, None)
        return {item.key: item for item in candidates}, [row(item.key, item.label, *values[item.key]) for item in candidates], diagnostics

    def get_entries(current):
        data = manager._parse_scope_text("global", current)
        return manager._list_under("global", data, key)

    def guard(current, revision):
        nonlocal items, before, wanted
        check_revision(command, revision)
        if not writable_store(store.selection()):
            raise Refusal("SCOPE_READONLY")
        items, before, _ = view(get_entries(current))
        # ResourceSelection.save puts the edited scope's own rows first, stably.
        wanted = sorted(edits_for(command, before), key=lambda edit: items[edit[0]].scope != "global")

    def edit(entries):
        nonlocal after
        for name, want in wanted:
            entries = grammar.edit(entries, items[name], want, scope="global", global_list=None, base_dir=base)
        _, after, _ = view(entries)
        return entries

    store = GuardedSettings(path, anchor, guard)
    data, revision = store_version(store.selection(), "settings")
    # This manager only supplies the CLI's parser and list editor. Its regular
    # constructor can be used without loading either settings file (the transaction reads the disk).
    manager = SettingsManager(store, Settings(), Settings(), project_trusted=False)
    try:
        if mutation:
            if not writable_store(store.selection()):
                check_revision(command, revision)
                raise Refusal("SCOPE_READONLY")
            asyncio.run(manager.edit_list("global", key, edit, nullable=grammar.nullable))
            return saved(command, store.revision, before, after)
        raw = get_entries(text_of(data))
        if raw is not None and (not isinstance(raw, list) or any(not isinstance(e, str) for e in raw)):
            raise Refusal("STORE_UNREADABLE")
        _, rows, diagnostics = view(raw)
        return listing(kind, revision, data is not None, rows, diagnostics, None if writable_store(store.selection()) else "read-only")
    except (SettingsFileError, UnicodeError):
        raise Refusal("STORE_UNREADABLE") from None
    except EditRefused:
        raise Refusal("SAVE_FAILED") from None
    except TimeoutError:
        raise Refusal("BUSY") from None
    except (OSError, Refusal) as error:
        if store.committed:
            raise Refusal("OUTCOME_UNKNOWN", retryable=False) from None
        if isinstance(error, Refusal):
            raise
        raise Refusal("STORE_UNREADABLE") from None

def mcp(command):
    selection = McpSelection(CWD, str(ROOT), False)
    kind = McpKind()

    def admit(here):
        if here.source not in ("global", "env"):
            raise Refusal("SCOPE_READONLY")
        return admit_store(here.path, ROOT if here.source == "global" else here.path.parent)

    def snapshot():
        here = selection._in_force()
        real = admit(here)
        data, revision = store_version(real, here.source)
        if data is not None:
            try:
                raw = mcp_writer._parse(mcp_writer._decode(data))
            except mcp_writer.McpRefused:
                raise Refusal("STORE_UNREADABLE") from None
            if not isinstance(raw, dict) or not isinstance(raw.get("mcpServers"), dict):
                raise Refusal("STORE_UNREADABLE")
            if len(raw["mcpServers"]) > SELECTION_ENTRIES:
                raise Refusal("RESULT_TOO_LARGE")
        with bounded_discovery(STORE_BYTES, real):
            loaded = selection._load()
        if loaded.here != here or admit(here) != real or store_version(real, here.source)[1] != revision:
            raise Refusal("BUSY")
        if here.source == "env":
            return here, listing("mcp", revision, data is not None, [], [diagnostic("env-config")], "env-config"), {}
        if here.source != "global":
            raise Refusal("SCOPE_READONLY")
        result = selection._rows(kind, loaded)
        if result.unreadable:
            raise Refusal("STORE_UNREADABLE")
        reason = None
        if data is None:
            reason = "missing-file"
        elif not writable_store(Path(here.real)):
            reason = "read-only"
        else:
            try:
                mcp_writer._refuse_unsafe(here.real, "mcp.json", Path(here.real).stat())
            except mcp_writer.McpRefused:
                reason = "read-only"
        states = {
            state.item.key: state for state in result.states
            if state.item.key and all(ord(c) >= 32 and ord(c) != 127 and not 0xD800 <= ord(c) <= 0xDFFF for c in state.item.key)
        }
        rows = [row(key, s.item.label, s.saved, s.decided_by, s.item.role,
                    dict(kind=s.lock.kind, value=s.lock.value, reason="invalid-mcp-entry") if s.lock else None,
                    "invalid-mcp-entry" if s.problem else None) for key, s in states.items()]
        diagnostics = [diagnostic("mcp-config-warning")] if result.problems else []
        if len(states) != len(result.states):
            diagnostics.append(diagnostic("invalid-mcp-key"))
        return here, listing("mcp", revision, data is not None, rows, diagnostics, reason), states

    mutation = command["action"] == "selections/set"
    if not mutation:
        return snapshot()[1]
    here = selection._in_force()
    real = admit(here)
    committed = False
    abandoned = threading.Event()
    # This is the same native lock and the same byte-preserving writer as write_enabled.
    # Take the snapshot, compare the revision, write and observe the commit before releasing it.
    try:
        if here.source != "global" or real != Path(here.real) or not real.is_file():
            _, before, _ = snapshot()
            check_revision(command, before["revision"])
            raise Refusal("SCOPE_READONLY")
        with mcp_writer._platform_lock(here.real, mcp_writer.LOCK_TIMEOUT_S, abandoned, "mcp.json"):
            current, before, states = snapshot()
            check_revision(command, before["revision"])
            if current != here:
                raise Refusal("REVISION_CONFLICT", currentRevision=before["revision"])
            if not before["writable"]:
                raise Refusal("SCOPE_READONLY")
            wanted = [(states[key].item.identities[0], on) for key, on in edits_for(command, before["items"])]
            if wanted:
                label = "mcp.json"
                info, data = mcp_writer._read_checked(here.real, label)
                check_revision(command, revision_for(Path(here.real), here.source, data, info))
                new = mcp_writer.edit_enabled(data, wanted)
                if selection._in_force() != here or admit(here) != real:
                    raise Refusal("REVISION_CONFLICT", currentRevision=snapshot()[1]["revision"])
                if len(new) > STORE_BYTES:
                    raise Refusal("RESULT_TOO_LARGE")
                if new != data:
                    mcp_writer._replace_file(here.real, label, info, data, new, abandoned)
                    committed = True
            current, after, _ = snapshot()
            if current != here:
                raise Refusal("REVISION_CONFLICT", currentRevision=after["revision"])
            return saved(command, after["revision"], before["items"], after["items"])
    except (mcp_writer.McpRefused, OSError) as error:
        if committed:
            raise Refusal("OUTCOME_UNKNOWN", retryable=False) from None
        if isinstance(error, mcp_writer.McpRefused):
            # The pinned native lock reports its deadline via a refusal with a stable prefix.
            code = "BUSY" if str(error).startswith("another aelix has been saving ") else "SAVE_FAILED"
            raise Refusal(code) from None
        raise Refusal("OUTCOME_UNKNOWN", retryable=False) from None
    except Refusal:
        if committed:
            raise Refusal("OUTCOME_UNKNOWN", retryable=False) from None
        raise

def main(command):
    try:
        if command["action"].startswith("profiles/"):
            with bounded_discovery() as content:
                data = profiles(command, content)
        elif command["kind"] == "mcp":
            data = mcp(command)
        else:
            data = settings(command)
        return dict(ok=True, data=data)
    except Refusal as error:
        return error.reply
    except RecursionError:
        return dict(ok=False, code="RESULT_TOO_LARGE")
    except (OSError, UnicodeError):
        if command["action"] == "selections/list":
            return dict(ok=False, code="STORE_UNREADABLE")
        raise

# Native libraries may write diagnostics. The sole stdout frame is the projected response.
with contextlib.redirect_stdout(sys.stderr):
    request = json.loads(sys.stdin.buffer.readline(60002))
    reply = main(request)
# Bound encoding as well: Markdown can reuse the same long YAML scalar many times.
encoder = json.JSONEncoder(ensure_ascii=True, allow_nan=False, separators=(",", ":"))
with io.StringIO() as frame:
    for part in encoder.iterencode(reply):
        if frame.tell() + len(part) >= CATALOG_BYTES:
            if request["action"] == "selections/set" and reply["ok"]:
                print('{"ok":false,"code":"OUTCOME_UNKNOWN","retryable":false}', flush=True)
            else:
                print('{"ok":false,"code":"RESULT_TOO_LARGE"}', flush=True)
            break
        frame.write(part)
    else:
        print(frame.getvalue(), flush=True)
`;
