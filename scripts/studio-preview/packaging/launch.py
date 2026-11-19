"""Relocatable host entrypoints for the unchanged public Preview wheels."""
from pathlib import Path
import os
import sys

# Child interpreters do not inherit -B. Keep every descendant out of the bundle.
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.dont_write_bytecode = True

# The Studio extension helper's state directory (Studio #32, D04 ADR 5.1). When it names a
# current generation bound to this bundle, new conversations load the extensions installed there.
EXTENSION_STATE = 'AELIX_STUDIO_EXTENSION_STATE'
_LEASES = []


def _studio_generation(bundle, state):
    """Site directory and ``--extension`` values of the current generation, or None.

    Follows the launcher contract of the helper (``store/lock.ts``): take the mutation lock,
    read the pointer in effect (``current.json``, else the copy kept from before the last
    switch), lock a lease on that generation for the life of this process, release the lock.
    A change holds the lock for as long as it installs; after a short wait the lease is taken
    without it and kept only if the generation is still one clean-up keeps (current or
    previous). That holds because clean-up runs under the lock after the change's switch, and
    a generation that left current/previous never comes back (D04 ADR 5.6).

    A lease is locked before it gets its name in ``leases/``: it is created as a pending file
    there, locked, then renamed. Clean-up removes only lease files it found unlocked, so a
    lease under its generation's name is never one it took for stale; if clean-up removed the
    pending file first, the rename fails and the lease is taken again. Anything unusable means
    the bundle alone, exactly as before extensions existed. Windows is not offered generations
    yet (Studio #32, stage 1a').
    """
    if os.name == 'nt' or not state or not os.path.isabs(state):
        return None
    import errno
    import fcntl
    import json
    import re
    import secrets
    import time

    generation_name = re.compile(r'g\d{8}-[0-9a-f]{4}')
    # What the adapter accepts as a module reference (``extension_reference`` at the ACP pin).
    module_reference = re.compile(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?::[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?')
    nofollow = getattr(os, 'O_NOFOLLOW', 0)

    def own(path):
        return path.is_dir() and not path.is_symlink() and os.path.realpath(path) == str(path)

    def read_json(path):
        try:
            with open(path, 'rb') as handle:
                value = json.loads(handle.read(1 << 20))
            return value if isinstance(value, dict) else None
        except (OSError, ValueError):
            return None

    manifest = read_json(bundle / 'manifest.json') or {}
    version = str(manifest.get('python') or '')
    source = (manifest.get('native') or {}).get('sourceTag') or {}
    binding = {
        'bundle': str(bundle),
        'target': manifest.get('target'),
        'pythonMinor': '.'.join(version.split('.')[:2]),
        'dependencyLockSha256': manifest.get('dependencyLockSha256'),
        'nativeCommit': source.get('commit'),
    }

    def record(root, generation):
        # A record the helper would not read does not count, so both agree on the generation in effect.
        directory = root / 'generations' / generation
        value = read_json(directory / 'generation.json') if own(directory) else None
        if not value or value.get('schema') != 'aelix.studio.extensions.generation/2':
            return None
        launch = value.get('launch')
        if value.get('generation') != generation or not isinstance(launch, dict):
            return None
        packs, modules = launch.get('packs'), launch.get('modules')
        if not isinstance(packs, bool) or not isinstance(modules, list):
            return None
        if not all(isinstance(module, str) and module_reference.fullmatch(module) for module in modules):
            return None
        return value

    def pointer_in_effect(root):
        for name in ('current.json', 'current.previous.json'):
            value = read_json(root / name)
            if not value or value.get('schema') != 'aelix.studio.extensions.current/1':
                continue
            current, previous, revision = value.get('generation'), value.get('previous'), value.get('revision')
            if not isinstance(current, str) or not generation_name.fullmatch(current):
                continue
            if previous is not None and not (isinstance(previous, str) and generation_name.fullmatch(previous)):
                continue
            if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
                continue
            found = record(root, current)
            if found:
                return current, previous, found
        return None

    def acquire(handle, wait):
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except OSError as error:
                if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES) or time.monotonic() >= deadline:
                    return False
                time.sleep(0.05)

    def lock(path, wait):
        try:
            handle = os.open(path, os.O_RDWR | os.O_CREAT | nofollow, 0o600)
        except OSError:
            return None
        if acquire(handle, wait):
            return handle
        os.close(handle)
        return None

    def lease(leases, generation):
        token = f'{os.getpid()}-{secrets.token_hex(4)}'
        # A name clean-up maps to no generation; it is renamed only once it is locked.
        pending = leases / f'.pending.{token}'
        handle = os.open(pending, os.O_RDWR | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        try:
            # The lease probe holds a lease it tests for an instant; wait that out.
            if acquire(handle, 1.0):
                final = leases / f'{generation}.{token}'
                os.rename(pending, final)
                if os.stat(final, follow_symlinks=False).st_ino == os.fstat(handle).st_ino:
                    return final, handle
                os.unlink(final)
        except OSError:
            pass
        try:
            os.unlink(pending)
        except OSError:
            pass
        os.close(handle)
        return None

    def release(held):
        # Out of the directory first, then unlocked: clean-up never sees it unlocked under its name.
        try:
            os.unlink(held[0])
        except OSError:
            pass
        os.close(held[1])

    def arguments_of(root, generation, found):
        directory = root / 'generations' / generation
        site = directory / 'venv' / 'lib' / f"python{binding['pythonMinor']}" / 'site-packages'
        packs, modules = found['launch']['packs'], found['launch']['modules']
        if not own(site) or (packs and not own(directory / 'packs')):
            return None
        extensions = [str(directory / 'packs')] * packs + modules
        return (str(site), extensions) if extensions else None

    if binding['pythonMinor'] == '':
        return None
    root = Path(os.path.realpath(state))
    if not own(root) or not own(root / 'generations') or not own(root / 'leases'):
        return None
    if not (root / 'current.json').exists() and not (root / 'current.previous.json').exists():
        return None
    mutation = lock(root / 'lock', 2.0)
    try:
        for _attempt in range(3):
            chosen = pointer_in_effect(root)
            # A mismatched current generation stays on disk for reconciliation or reinstall.
            # It must not lend its paths or extension arguments to this adapter.
            if not chosen or chosen[2].get('binding') != binding:
                return None
            held = lease(root / 'leases', chosen[0])
            if not held:
                continue
            again = pointer_in_effect(root)
            if again and chosen[0] in (again[0], again[1]):
                break
            release(held)
        else:
            return None
    finally:
        if mutation is not None:
            os.close(mutation)
    result = arguments_of(root, chosen[0], chosen[2])
    if result is None:
        release(held)
    else:
        _LEASES.append(held)
    return result


def _release_leases():
    """Give back the leases of this process when it ends normally; clean-up removes any left behind."""
    for file, handle in _LEASES:
        try:
            os.unlink(file)
        except OSError:
            pass
        os.close(handle)
    _LEASES.clear()


root = Path(__file__).resolve().parent
if sys.platform == 'win32' and not str(root).startswith('\\\\?\\'):
    root = Path('\\\\?\\UNC\\' + str(root)[2:] if str(root).startswith('\\\\') else '\\\\?\\' + str(root))
mode, *arguments = sys.argv[1:]
site = root / ('adapter-site' if mode == 'acp' else 'native-site')
sys.path.insert(0, str(site))
_dll_handles = []
if sys.platform == 'win32' and mode != 'acp':
    # Only the declared, wheel-audited pywin32 bootstrap. Never execute arbitrary
    # .pth startup files or write system DLLs/registry via postinstall scripts.
    sys.path[:0] = [str(site / name) for name in ('win32', 'win32/lib', 'Pythonwin')]
    _dll_handles.append(os.add_dll_directory(str(site / 'pywin32_system32')))
    import pywin32_bootstrap
if mode == 'helper':
    arguments = [arg for arg in arguments if arg not in ('-I', '-B')]
    if len(arguments) != 2 or arguments[0] != '-c':
        raise SystemExit('Unsupported helper invocation')
    exec(compile(arguments[1], '<studio-native-auth>', 'exec'), {'__name__': '__main__'})
elif mode in ('native', 'native-generation'):
    if mode == 'native-generation':
        # The conversation form (D04 ADR 5.2): the generation's site-packages goes last, after
        # native-site and the standard library, so the bundle always wins a name.
        if not arguments or not os.path.isabs(arguments[0]):
            raise SystemExit('Unsupported runtime entrypoint')
        sys.path.append(arguments.pop(0))
    sys.argv = ['aelix', *arguments]
    from aelix_coding_agent.cli.entry import main_sync
    main_sync()
elif mode == 'acp':
    state = os.environ.pop(EXTENSION_STATE, '')
    if any(arg == '--aelix' or arg.startswith('--aelix=') for arg in arguments):
        prefix = []
    else:
        try:
            generation = _studio_generation(root, state)
        except Exception:  # noqa: BLE001 -- extensions must never keep a conversation from starting
            generation = None
            print('[studio] installed extensions were not loaded', file=sys.stderr)
        native = ['--aelix-arg=native'] if generation is None else [
            '--aelix-arg=native-generation', '--aelix-arg=' + generation[0]]
        prefix = ['--aelix', sys.executable, '--aelix-arg=-I', '--aelix-arg=-S', '--aelix-arg=-B',
                  '--aelix-arg=-Xutf8', '--aelix-arg=' + str(root / 'launch.py'), *native]
        for extension in [] if generation is None else generation[1]:
            prefix += ['--extension', extension]
        if _LEASES:
            import atexit
            atexit.register(_release_leases)
    sys.argv = ['aelix-acp', *prefix, *arguments]
    from aelix_acp.server import main
    main()
else:
    raise SystemExit('Unsupported runtime entrypoint')
