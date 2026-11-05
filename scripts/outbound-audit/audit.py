"""Compatibility CLI: the Studio and host/native gates use one audit policy."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'studio-preview/fixtures'))
from outboundAudit import audit, main
from outboundScope import analyze_processes


def analyze_trace(path):
    return analyze_processes([path], require_lifecycle=True)[0]


if __name__ == '__main__':
    sys.exit(main())
