/** A single request in the selected runtime's embedded Python. Only native offline APIs are imported. */
export const NATIVE_RESOURCES_HELPER = String.raw`
import asyncio
import contextlib
import errno
import hashlib
import hmac
import io
import json
import os
import stat
import sys
import threading
from functools import cache
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

PROCESS_EVENTS = {"subprocess.Popen", "os.posix_spawn", "os.system", "os.exec", "os.spawn", "os.fork"}
# The helper is sessionless: no model, catalog, MCP or other network traffic.
NETWORK_EVENTS = {
    "socket.connect", "socket.bind", "socket.sendto", "socket.sendmsg", "socket.getaddrinfo",
    "socket.gethostbyname", "socket.gethostbyaddr", "socket.getnameinfo",
}
DENIED = []

def refuse_denied():
    """Stop before a commit if native code swallowed a refused process or network attempt."""
    if DENIED:
        raise Refusal("HELPER_UNAVAILABLE")

def protect_native_io(event, args):
    if event in PROCESS_EVENTS or event in NETWORK_EVENTS:
        # Native code may catch the refusal and carry on. main() still fails closed.
        DENIED.append(event)
        raise Refusal("HELPER_UNAVAILABLE")
    if event == "open" and isinstance(args[0], (str, bytes)):
        real = Path(os.fsdecode(args[0])).resolve()
        info = file_info(real) if STARTUP_CREDENTIALS else None
        if real in AUTH_NAMES or (info is not None and identity(info) in STARTUP_CREDENTIALS):
            raise PermissionError("credential store is outside native resource discovery")

# The event loop's self-pipe is a socketpair (emulated with bind and connect on
# Windows), so the one loop the settings writer needs is created before the guard.
LOOP = asyncio.new_event_loop()
# Native discovery follows links. Recheck credential identities at each open.
sys.addaudithook(protect_native_io)
with contextlib.redirect_stdout(sys.stderr):
    from aelix_ai.settings.settings_manager import Settings, SettingsManager, SettingsFileError
    from aelix_ai.settings import storage as native_storage
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

@cache
def windows_user():
    import win32api
    import win32con
    import win32security
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        return win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()

PRIVATE_GROUPS = {}

def private_group(gid):
    """Debian/OpenSSH user-private-group rule: group write is only this user's own write.

    The helper serves one command per process, so the answer is cached for the
    whole write: a transient NSS miss after admission cannot turn a landed
    write into OUTCOME_UNKNOWN.
    """
    if gid not in PRIVATE_GROUPS:
        PRIVATE_GROUPS[gid] = lookup_private_group(gid)
    return PRIVATE_GROUPS[gid]

def lookup_private_group(gid):
    import grp
    import pwd
    try:
        user = pwd.getpwuid(os.geteuid())
        group = grp.getgrgid(gid)
        if (user.pw_gid != gid or group.gr_name != user.pw_name
                or any(member != user.pw_name for member in group.gr_mem)):
            return False
        # gr_mem lists supplementary members only. An account whose primary
        # group this is shares it too (Debian user-group-modes). getpwall()
        # sees only what NSS enumerates: with enumeration off (the SSSD
        # default), directory accounts are not listed, as in Debian's rule.
        # The scan runs at most once per gid per helper process.
        return all(entry.pw_gid != gid or entry.pw_uid == user.pw_uid for entry in pwd.getpwall())
    except Exception:
        return False

def posix_acl(path):
    """Whether a Linux POSIX ACL may grant write to someone the group bits do not name.

    With an access ACL the group bits are the ACL mask, so S_IWGRP means a named
    user or group may write. macOS ACLs are not visible in the mode bits and
    Python cannot list them; like OpenSSH, they are not inspected. NFSv4 and
    CIFS ACLs (system.nfs4_acl and similar) are not inspected either.
    """
    listxattr = getattr(os, "listxattr", None)
    if listxattr is None:
        return False
    try:
        return "system.posix_acl_access" in listxattr(path, follow_symlinks=False)
    except OSError as error:
        # A file system without extended attributes has no ACL. Anything else is unverified.
        return error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP)

def private_directory(path, info):
    if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return False
    if os.name != "nt":
        return (info.st_uid == os.geteuid() and not info.st_mode & stat.S_IWOTH
            and (not info.st_mode & stat.S_IWGRP or (not posix_acl(path) and private_group(info.st_gid))))
    try:
        import win32security as security
        owner = windows_user()
        descriptor = security.GetNamedSecurityInfo(str(path), security.SE_FILE_OBJECT,
            security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION)
        acl = descriptor.GetSecurityDescriptorDacl()
        if descriptor.GetSecurityDescriptorOwner() != owner or acl is None:
            return False
        trusted = {security.ConvertSidToStringSid(owner), "S-1-5-18", "S-1-5-32-544"}
        for index in range(acl.GetAceCount()):
            ace = acl.GetAce(index)
            kind, flags = ace[0]
            if flags & 0x08:  # INHERIT_ONLY_ACE
                continue
            if kind not in (0, 1, 5, 6):
                return False
            if kind in (0, 5) and ace[1] & 0x500D0156 and security.ConvertSidToStringSid(ace[-1]) not in trusted:
                return False
        return True
    except Exception:
        return False

def file_id(info, code):
    if not info.st_ino or (os.name == "nt" and not info.st_dev):
        raise Refusal(code)
    return identity(info)

def opened_id(fd):
    # CPython 3.12 fills the Windows volume and file ID from the handle, in the
    # same format as lstat. Without them the handle is unverified and refused.
    return file_id(os.fstat(fd), "STORE_UNREADABLE")

# Same-user threat model for global settings writes.
#
# The attacker is another local process running as this user. It cannot be
# confined: it can edit the files itself. What it must not do is redirect a
# Studio write, or make Studio report a save that did not land on the admitted
# file. The native writer opens the sidecar lock and the temp file by path, and
# Studio keeps that writer instead of reimplementing it. So, as defence in depth:
#   1. The agent root (or the directory of an AELIX_SETTINGS_PATH outside it)
#      is resolved once to its real path, so a dotfile-style link to the root is
#      allowed. Below that resolved root, the lock directory and every settings
#      directory must be real directories (no link, junction or reparse point).
#      The resolved root and those directories must be owned by this user and
#      not writable by others. Group write is allowed only for this user's
#      private group: the user's primary gid, named after the user, with no
#      other supplementary member and no other account's primary group, and no
#      Linux POSIX access ACL (Debian's umask 002 layout). NSS answers are cached
#      for the command. Anything else is refused with SCOPE_READONLY.
#   2. On POSIX those directories stay open (O_DIRECTORY|O_NOFOLLOW) for the
#      whole transaction, and each child is opened relative to its pinned parent.
#   3. After the native lock is taken, around the replacement and after it, the
#      identities (st_dev/st_ino, or the Windows volume and file ID) of the lock
#      file, the settings target and those directories are checked again, and
#      the configured root must still resolve to the pinned one. A mismatch
#      fails closed: STORE_UNREADABLE before the commit, OUTCOME_UNKNOWN after
#      it. An unavailable file ID counts as a mismatch, on Windows too.
# A same-user process that swaps and restores a path between two checks can
# still win. These checks catch every swap that is still visible.
class SettingsPaths:
    """Hold identities (and POSIX directory handles) across the native transaction."""
    def __init__(self, stack):
        self.stack = stack
        # Pinned real directories, and the configured spellings native code uses for them.
        self.directories = {}
        self.aliases = {}

    def pin_store(self, store, real, create):
        """Pin the resolved root, the configured and real target chains, and the lock directory."""
        configured = store.global_path.parent
        anchor = ROOT if configured.is_relative_to(ROOT) else store.anchor
        if not os.path.lexists(anchor):
            if not create:
                return
            # The native writer would create the root with its parents.
            try:
                os.makedirs(anchor, 0o700, exist_ok=True)
            except OSError:
                raise Refusal("SCOPE_READONLY") from None
        try:
            real_anchor = anchor.resolve(strict=True)
        except (OSError, RuntimeError):
            raise Refusal("SCOPE_READONLY") from None
        real_configured = real_anchor / configured.relative_to(anchor)
        self.pin_chain(real_configured, real_anchor)
        self.pin_chain(real.parent, real_anchor)
        self.aliases[anchor] = real_anchor
        self.aliases[configured] = real_configured
        locks = real_configured / "locks"
        if create or os.path.lexists(locks):
            self.pin(locks, create=create)
            self.aliases[configured / "locks"] = locks

    def real(self, directory):
        return self.aliases.get(directory, directory)

    def pin_chain(self, directory, anchor):
        cursor = anchor
        self.pin(cursor)
        try:
            parts = directory.relative_to(anchor).parts
        except ValueError:
            raise Refusal("SCOPE_READONLY") from None
        for part in parts:
            cursor = cursor / part
            self.pin(cursor)

    def pin(self, path, create=False):
        if path in self.directories:
            return
        parent = self.directories.get(path.parent, (None, None))[1]
        fd = None
        try:
            if create:
                try:
                    os.mkdir(path.name if parent is not None else path, 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
            info = path.lstat()
            if not private_directory(path, info):
                raise Refusal("SCOPE_READONLY")
            key = file_id(info, "SCOPE_READONLY")
            if hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW") and os.name != "nt":
                fd = os.open(path.name if parent is not None else path,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                self.stack.callback(os.close, fd)
                pinned = os.fstat(fd)
                if file_id(pinned, "SCOPE_READONLY") != key or not private_directory(path, pinned):
                    raise Refusal("SCOPE_READONLY")
            self.directories[path] = key, fd
        except OSError:
            raise Refusal("SCOPE_READONLY") from None

    def verify(self):
        for configured, real in self.aliases.items():
            try:
                if Path(os.path.realpath(configured)) != real:
                    raise Refusal("STORE_UNREADABLE")
            except OSError:
                raise Refusal("STORE_UNREADABLE") from None
        for path, (expected, fd) in self.directories.items():
            try:
                live = path.lstat()
                if not private_directory(path, live) or file_id(live, "STORE_UNREADABLE") != expected:
                    raise Refusal("STORE_UNREADABLE")
                if fd is not None and opened_id(fd) != expected:
                    raise Refusal("STORE_UNREADABLE")
            except OSError:
                raise Refusal("STORE_UNREADABLE") from None

    def regular(self, path, single_link=False):
        parent = self.real(path.parent)
        fd = self.directories[parent][1]
        try:
            info = (parent / path.name).lstat() if fd is None else os.stat(path.name, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if (not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
                or credential(info) or (single_link and info.st_nlink != 1)):
            raise Refusal("STORE_UNREADABLE")
        return file_id(info, "STORE_UNREADABLE")

def private_settings(store):
    """Apply the write path's directory policy to a listing without creating anything."""
    try:
        with contextlib.ExitStack() as stack:
            SettingsPaths(stack).pin_store(store, store.selection(), create=False)
        return True
    except Refusal:
        return False

class GuardedSettings(FileSettingsStorage):
    """Use the native CLI's transaction, sidecar and atomic writer.

    See the same-user threat model above SettingsPaths for what is pinned and rechecked.
    """
    def __init__(self, path, anchor, guard):
        super().__init__(CWD, ROOT, global_path=path)
        self.anchor = anchor
        self.guard = guard
        self.committed = False
        self.revision = None
        self.locked = None
        self.lock_fd = None

    def selection(self):
        return admit_store(self.global_path, self.anchor)

    def target(self, scope):
        return self.locked if self.locked is not None else super().target(scope)

    def _lock_fd(self, fd, path):
        self.paths.verify()
        if self.lock_fd is None:
            opened = opened_id(fd)
            if self.paths.regular(self.sidecar, True) != opened or (self.lock_key is not None and self.lock_key != opened):
                raise Refusal("STORE_UNREADABLE")
            super()._lock_fd(fd, path)
            self.lock_fd = fd
            self.lock_key = opened
            self.check_target(path)
            # A cooperating CLI can replace the target while we wait. Its new
            # identity is the one whose revision is checked under this lock.
            self.target_key = self.paths.regular(path)
        else:
            if opened_id(fd) != self.target_key:
                raise Refusal("STORE_UNREADABLE")
            super()._lock_fd(fd, path)
        self.verify_locked(path)

    @contextlib.contextmanager
    def _sidecar_lock(self, path):
        self.sidecar = self._sidecar_path(path)
        if self.paths.real(self.sidecar.parent) not in self.paths.directories:
            raise Refusal("STORE_UNREADABLE")
        self.paths.verify()
        self.lock_key = self.paths.regular(self.sidecar, True)
        try:
            with super()._sidecar_lock(path):
                self.verify_locked(path)
                yield
                self.verify_locked(path)
        finally:
            self.lock_fd = None

    def check_target(self, path):
        current = self.selection()
        if current != path:
            raise Refusal("REVISION_CONFLICT", currentRevision=store_version(current, "settings")[1])

    def verify_locked(self, path):
        self.paths.verify()
        self.check_target(path)
        if (self.lock_fd is None or opened_id(self.lock_fd) != self.lock_key
                or self.paths.regular(self.sidecar, True) != self.lock_key
                or self.paths.regular(path) != self.target_key):
            raise Refusal("STORE_UNREADABLE")

    def _read_text_strict(self, path):
        self.verify_locked(path)
        return text_of(raw_file(path, follow=False)[0])

    def transact(self, scope, build):
        self.locked = self.selection()
        try:
            with contextlib.ExitStack() as stack:
                self.paths = SettingsPaths(stack)
                self.paths.pin_store(self, self.locked, create=True)
                def checked(current):
                    self.verify_locked(self.locked)
                    raw, current_revision = store_version(self.locked, "settings")
                    if text_of(raw) != current:
                        raise Refusal("REVISION_CONFLICT", currentRevision=current_revision)
                    self.revision = current_revision
                    self.guard(current, current_revision)
                    return build(current)
                super().transact(scope, checked)
        finally:
            self.locked = None

    def _write_text_atomic(self, path, payload):
        self.verify_locked(path)
        if len(payload.encode("utf-8")) > STORE_BYTES:
            raise Refusal("RESULT_TOO_LARGE")
        native_replace = native_storage._replace
        def witnessed_replace(src, dst):
            self.verify_locked(path)
            if dst != path or src.parent != path.parent:
                raise Refusal("STORE_UNREADABLE")
            replacement = self.paths.regular(src, True)
            if replacement is None:
                raise Refusal("STORE_UNREADABLE")
            refuse_denied()
            native_replace(src, dst)
            self.committed = True
            self.target_key = replacement
            self.verify_locked(path)
        try:
            # The helper runs one command. Use the native writer and witness
            # its actual temp file, including the intentional inode change.
            native_storage._replace = witnessed_replace
            super()._write_text_atomic(path, payload)
        except OSError:
            raise Refusal("SAVE_FAILED") from None
        finally:
            native_storage._replace = native_replace
        self.verify_locked(path)
        data, self.revision = store_version(path, "settings")
        if data != payload.encode("utf-8"):
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
            if not writable_store(store.selection()) or not private_settings(store):
                check_revision(command, revision)
                raise Refusal("SCOPE_READONLY")
            LOOP.run_until_complete(manager.edit_list("global", key, edit, nullable=grammar.nullable))
            return saved(command, store.revision, before, after)
        raw = get_entries(text_of(data))
        if raw is not None and (not isinstance(raw, list) or any(not isinstance(e, str) for e in raw)):
            raise Refusal("STORE_UNREADABLE")
        _, rows, diagnostics = view(raw)
        writable = writable_store(store.selection()) and private_settings(store)
        return listing(kind, revision, data is not None, rows, diagnostics, None if writable else "read-only")
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
                    refuse_denied()
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
    if DENIED and reply["ok"]:
        # Writes stop before their commit (refuse_denied). An attempt after the
        # commit, or during a read, still fails the request closed here.
        write = request["action"] == "selections/set"
        reply = dict(ok=False, code="OUTCOME_UNKNOWN", retryable=False) if write else dict(ok=False, code="HELPER_UNAVAILABLE")
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
