/** A single request in the selected runtime's embedded Python. Only native offline APIs are imported. */
export const NATIVE_RESOURCES_HELPER = String.raw`
import asyncio
import contextlib
import hashlib
import hmac
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
AUTH_PATHS = {path.resolve() for path in (
    ROOT / "auth.json", HOME / ".aelix/agent/auth.json", HOME / ".config/aelix/agent/auth.json",
    Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config") / "aelix/agent/auth.json",
)}
if os.environ.get("AELIX_AUTH_PATH"):
    AUTH_PATHS.add(Path(os.environ["AELIX_AUTH_PATH"]).resolve())

def protect_credentials(event, args):
    if event == "open" and isinstance(args[0], (str, bytes)):
        if Path(os.fsdecode(args[0])).resolve() in AUTH_PATHS:
            raise PermissionError("credential store is outside native resource discovery")

# Discovery follows file symlinks, so enforce the boundary before native opens.
sys.addaudithook(protect_credentials)
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

class Refusal(Exception):
    def __init__(self, code, **detail):
        self.reply = dict(ok=False, code=code, **detail)

def diagnostic(code, key=None, source=None):
    return dict(code=code, key=key, source=source)

def raw_file(path):
    # A store can be absent. A special file, bad link, or read error cannot stand in for absence.
    try:
        resolved = path.resolve(strict=True)
    except FileNotFoundError:
        return None, None
    if resolved in AUTH_PATHS or not resolved.is_file():
        raise Refusal("STORE_UNREADABLE")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    with os.fdopen(os.open(resolved, flags), "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise Refusal("STORE_UNREADABLE")
        return stream.read(), info

def store_version(path, source):
    real = path.resolve()
    data, info = raw_file(real)
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

def profiles(command):
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
            raw, _ = raw_file(actual)
            text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n") if raw is not None else ""
        except (OSError, UnicodeError, Refusal):
            diagnostics.append(diagnostic("invalid-profile", source=source(path, original.scope)))
            continue
        # Bind the public ref and the preview to the same bytes even if the discovery read raced an edit.
        result = parse_profile(text, file_path=str(path), scope=original.scope)
        parsed = result.profile
        if parsed is None or parsed.name != original.name or raw is None:
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
    def __init__(self, path, guard):
        super().__init__(CWD, ROOT, global_path=path.resolve())
        self.selection_path = path
        self.guard = guard
        self.committed = False
        self.revision = None

    def _read_text_strict(self, path):
        return text_of(raw_file(path)[0])

    def transact(self, scope, build):
        locked = self.target(scope)
        def checked(current):
            raw, current_revision = store_version(locked, "settings")
            if self.selection_path.resolve() != locked or text_of(raw) != current:
                raise Refusal("REVISION_CONFLICT", currentRevision=store_version(self.selection_path, "settings")[1])
            self.revision = current_revision
            self.guard(current, current_revision)
            return build(current)
        super().transact(scope, checked)

    def _write_text_atomic(self, path, payload):
        if self.selection_path.resolve() != path:
            raise Refusal("REVISION_CONFLICT", currentRevision=store_version(self.selection_path, "settings")[1])
        try:
            super()._write_text_atomic(path, payload)
        except OSError:
            raise Refusal("SAVE_FAILED") from None
        self.committed = True
        data, self.revision = store_version(path, "settings")
        if self.selection_path.resolve() != path or data != payload.encode("utf-8"):
            raise Refusal("OUTCOME_UNKNOWN", retryable=False)

def writable_store(target):
    parent = next((ancestor for ancestor in target.parents if ancestor.exists()), target.parent)
    if not parent.is_dir() or not parent.stat().st_mode & stat.S_IWUSR or not os.access(parent, os.W_OK | os.X_OK):
        return False
    return not target.is_file() or (bool(target.stat().st_mode & stat.S_IWUSR) and os.access(target, os.W_OK))

def settings(command):
    kind = command["kind"]
    key = "defaultTools" if kind == "tool" else "skills"
    path = Path(os.environ["AELIX_SETTINGS_PATH"]) if os.environ.get("AELIX_SETTINGS_PATH") else ROOT / "settings.json"
    base = str(path.parent)
    grammar = DefaultToolsGrammar(ALL_TOOL_NAMES) if kind == "tool" else grammar_of(None)
    mutation = command["action"] == "selections/set"
    wanted, before, after = [], [], []
    items = {}

    def view(entries):
        valid, problems = grammar.validate(entries)
        selections = ScopeList("global", tuple(valid or ()), base, present=valid is not None)
        diagnostics = [diagnostic("invalid-settings-entry")] if problems else []
        if kind == "tool":
            candidates = [ResourceItem(kind=kind, key=name, label=name, identities=(name,)) for name in sorted(ALL_TOOL_NAMES)]
        else:
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
        if not writable_store(path.resolve()):
            raise Refusal("SCOPE_READONLY")
        items, before, _ = view(get_entries(current))
        wanted = edits_for(command, before)

    def edit(entries):
        nonlocal after
        for name, want in wanted:
            entries = grammar.edit(entries, items[name], want, scope="global", global_list=None, base_dir=base)
        _, after, _ = view(entries)
        return entries

    store = GuardedSettings(path, guard)
    data, revision = store_version(path, "settings")
    # This manager only supplies the CLI's parser and list editor. Its regular
    # constructor can be used without loading either settings file (the transaction reads the disk).
    manager = SettingsManager(store, Settings(), Settings(), project_trusted=False)
    try:
        if mutation:
            if not writable_store(path.resolve()):
                check_revision(command, revision)
                raise Refusal("SCOPE_READONLY")
            asyncio.run(manager.edit_list("global", key, edit, nullable=grammar.nullable))
            return saved(command, store.revision, before, after)
        raw = get_entries(text_of(data))
        if raw is not None and (not isinstance(raw, list) or any(not isinstance(e, str) for e in raw)):
            raise Refusal("STORE_UNREADABLE")
        _, rows, diagnostics = view(raw)
        return listing(kind, revision, data is not None, rows, diagnostics, None if writable_store(path.resolve()) else "read-only")
    except (SettingsFileError, UnicodeError):
        raise Refusal("STORE_UNREADABLE") from None
    except EditRefused:
        raise Refusal("SAVE_FAILED") from None
    except TimeoutError:
        raise Refusal("BUSY") from None
    except OSError:
        if store.committed:
            raise Refusal("OUTCOME_UNKNOWN", retryable=False) from None
        raise Refusal("STORE_UNREADABLE") from None

def mcp(command):
    selection = McpSelection(CWD, str(ROOT), False)
    kind = McpKind()

    def snapshot():
        here = selection._in_force()
        data, revision = store_version(here.path, here.source)
        if data is not None:
            try:
                raw = mcp_writer._parse(mcp_writer._decode(data))
            except mcp_writer.McpRefused:
                raise Refusal("STORE_UNREADABLE") from None
            if not isinstance(raw, dict) or not isinstance(raw.get("mcpServers"), dict):
                raise Refusal("STORE_UNREADABLE")
        loaded = selection._load()
        if loaded.here != here or store_version(here.path, here.source)[1] != revision:
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
    committed = False
    abandoned = threading.Event()
    # This is the same native lock and the same byte-preserving writer as write_enabled.
    # Take the snapshot, compare the revision, write and observe the commit before releasing it.
    try:
        if here.source != "global" or not Path(here.real).parent.is_dir():
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
                if selection._in_force() != here:
                    raise Refusal("REVISION_CONFLICT", currentRevision=snapshot()[1]["revision"])
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
            data = profiles(command)
        elif command["kind"] == "mcp":
            data = mcp(command)
        else:
            data = settings(command)
        return dict(ok=True, data=data)
    except Refusal as error:
        return error.reply
    except (OSError, UnicodeError):
        if command["action"] == "selections/list":
            return dict(ok=False, code="STORE_UNREADABLE")
        raise

# Native libraries may write diagnostics. The sole stdout frame is the projected response.
with contextlib.redirect_stdout(sys.stderr):
    request = json.loads(sys.stdin.buffer.readline(60002))
    reply = main(request)
print(json.dumps(reply, ensure_ascii=True, allow_nan=False, separators=(",", ":")), flush=True)
`;
