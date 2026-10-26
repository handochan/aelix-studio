"""Relocatable host entrypoints for the unchanged public Preview wheels."""
from pathlib import Path
import os
import sys

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
elif mode == 'native':
    sys.argv = ['aelix', *arguments]
    from aelix_coding_agent.cli.entry import main_sync
    main_sync()
elif mode == 'acp':
    prefix = [] if any(arg == '--aelix' or arg.startswith('--aelix=') for arg in arguments) else [
        '--aelix', sys.executable, '--aelix-arg=-I', '--aelix-arg=-S', '--aelix-arg=-B',
        '--aelix-arg=-Xutf8', '--aelix-arg=' + str(root / 'launch.py'), '--aelix-arg=native']
    sys.argv = ['aelix-acp', *prefix, *arguments]
    from aelix_acp.server import main
    main()
else:
    raise SystemExit('Unsupported runtime entrypoint')
