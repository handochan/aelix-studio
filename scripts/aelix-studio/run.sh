#!/bin/sh
# Run upstream tooling with the repository-local Node and Bun toolchain.
set -eu
STUDIO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
STUDIO_BIN="$STUDIO_ROOT/.local/toolchains/bin"
if [ ! -x "$STUDIO_BIN/node" ] || [ ! -x "$STUDIO_BIN/bun" ]; then
  echo "Missing local toolchain; see docs/aelix-studio/README.md" >&2
  exit 1
fi
export PATH="$STUDIO_BIN:$PATH"
export BUN_INSTALL_CACHE_DIR="$STUDIO_ROOT/.local/bun-cache"
export npm_config_cache="$STUDIO_ROOT/.local/npm-cache"
export ELECTRON_CACHE="$STUDIO_ROOT/.local/electron-cache"
export PLAYWRIGHT_BROWSERS_PATH="$STUDIO_ROOT/.local/playwright"
cd "$STUDIO_ROOT"
if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/aelix-studio/run.sh <bun arguments>" >&2
  echo "Examples: install --frozen-lockfile | run package | run dev" >&2
  exit 1
fi
if [ "${1:-}" = "run" ]; then
  case "${2:-}" in
    dev|start|start:multi)
      if [ -z "${AIONUI_BACKEND_BIN:-}" ]; then
        STUDIO_TARGET=$(node -p 'process.platform + "-" + process.arch')
        STUDIO_BACKEND="$STUDIO_ROOT/resources/bundled-aioncore/$STUDIO_TARGET/aioncore"
        if [ ! -x "$STUDIO_BACKEND" ]; then
          echo "Missing pinned backend; run node scripts/prepareAioncore.js first" >&2
          exit 1
        fi
        export AIONUI_BACKEND_BIN="$STUDIO_BACKEND"
      fi
      ;;
  esac
fi
exec bun "$@"
