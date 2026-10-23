"""Relocatable entrypoint: ignore user Python paths and use only bundled packages."""
from pathlib import Path
import json
import os
import shutil
import site
import sys
import tempfile


def analytics_environment(root, state_dir):
    """Seed a relocatable wheel cache in writable app data, keeping project environments separate."""
    receipt = json.loads((root/'manifest.json').read_text(encoding='utf-8'))
    digest = receipt['analyticsLockSha256']
    if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise RuntimeError('Invalid bundled Analytics lock receipt')
    target = receipt.get('target', sys.platform)
    if not isinstance(target, str) or not target or any(not (c.isalnum() or c in '-_') for c in target):
        raise RuntimeError('Invalid bundled Analytics target receipt')
    cache = Path(state_dir).resolve().parent/'analytics-cache'/f'{target}-{digest[:16]}'
    cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not cache.is_dir():
        with tempfile.TemporaryDirectory(prefix='seed-', dir=cache.parent) as temporary:
            staged = Path(temporary)/'cache'
            shutil.copytree(long_path(root/'analytics-cache'), long_path(staged), symlinks=True)
            try:
                staged.rename(cache)
            except OSError:
                # Another team member may finish seeding the same immutable cache first.
                if not cache.is_dir():
                    raise
    return {
        'AELIX_ANALYTICS_UV': str(root/'bin'/('uv.exe' if sys.platform == 'win32' else 'uv')),
        'UV_CACHE_DIR': str(cache),
        'UV_PYTHON': sys.executable,
        'UV_PYTHON_DOWNLOADS': 'never',
        'UV_LINK_MODE': 'copy',
        'UV_OFFLINE': os.environ.get('UV_OFFLINE', '1'),
        'PYTHONDONTWRITEBYTECODE': '1',
        'PATH': str(root/'bin') + os.pathsep + os.environ.get('PATH', ''),
    }


def long_path(path):
    """Support deep wheel cache entries without changing the user's Windows long-path policy."""
    value = str(Path(path).resolve())
    if sys.platform == 'win32' and not value.startswith('\\\\?\\'):
        value = '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value
    return Path(value)


def argument(name, default):
    for index, value in enumerate(sys.argv):
        if value.startswith(name + '='):
            return value.split('=', 1)[1]
        if value == name and index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return default


def main():
    sys.dont_write_bytecode = True
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root/'site'))
    # Process trusted wheel .pth files, including pywin32's DLL and import paths.
    site.addsitedir(str(root/'site'))
    mode = sys.argv.pop(1)
    if mode == 'aelix':
        from aelix_coding_agent.cli.entry import main_sync
        main_sync()
    elif mode == 'acp':
        if argument('--profile', 'coding') == 'analytics':
            state = argument('--state-dir', str(Path.home()/'.aelix-studio/acp/analytics'))
            os.environ.update(analytics_environment(root, state))
        # Explicit bundled child command: never resolve a developer's global Aelix.
        sys.argv[1:1] = ['--aelix', sys.executable, '--aelix-arg=-I', '--aelix-arg=-B',
                        f'--aelix-arg={root/"launch.py"}', '--aelix-arg=aelix',
                        '--analytics-extension', str(root/'site/aelix_analytics/extension.py')]
        from aelix_acp.server import main as run_acp
        run_acp()
    else:
        raise SystemExit(f'Unknown bundled runtime mode: {mode}')


if __name__ == '__main__':
    main()
