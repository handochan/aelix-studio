"""Relocatable host entrypoints for the unchanged public Preview wheels."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
mode, *arguments = sys.argv[1:]
site = root / ('adapter-site' if mode == 'acp' else 'native-site')
sys.path.insert(0, str(site))
if mode == 'helper':
    arguments = [arg for arg in arguments if arg not in ('-I', '-B')]
    if len(arguments) != 2 or arguments[0] != '-c':
        raise SystemExit('Unsupported helper invocation')
    exec(compile(arguments[1], '<studio-native-auth>', 'exec'), {'__name__': '__main__'})
elif mode == 'native':
    sys.argv = [str(root / 'native/bin/aelix'), *arguments]
    from aelix_coding_agent.cli.entry import main_sync
    main_sync()
elif mode == 'acp':
    sys.argv = [str(root / 'adapter/bin/aelix-acp'), *arguments]
    from aelix_acp.server import main
    main()
else:
    raise SystemExit('Unsupported runtime entrypoint')
