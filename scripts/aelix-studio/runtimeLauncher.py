"""Relocatable entrypoint: ignore user Python paths and use only bundled packages."""
from pathlib import Path
import sys

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / 'site'))
mode = sys.argv.pop(1)
if mode == 'aelix':
    from aelix_coding_agent.cli.entry import main_sync
    main_sync()
elif mode == 'acp':
    # Explicit bundled child command: never resolve a developer's global Aelix.
    sys.argv[1:1] = ['--aelix', str(root / 'bin' / 'aelix')]
    from aelix_acp.server import main
    main()
else:
    raise SystemExit(f'Unknown bundled runtime mode: {mode}')
