"""Stable CLI entry point for the Linux kernel io_uring capability probe."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from uring.probe import main

if __name__=='__main__':
    raise SystemExit(main())
