#!/usr/bin/env bash
set -euo pipefail

MIRROR="${1:?Usage: $0 <mirror-url> <version>}"
VERSION="${2:?Pass the version stamped into the installer}"
SMOKE_DIR=$(mktemp -d)
trap 'rm -rf -- "$SMOKE_DIR"' EXIT
INSTALLER="$SMOKE_DIR/install-aelix-studio-web.sh"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

case "$MIRROR" in
  file://*) cp "${MIRROR#file://}/install-aelix-studio-web.sh" "$INSTALLER" ;;
  https://*) curl -q --proto '=https' --proto-redir '=https' -fsSL -o "$INSTALLER" -- "$MIRROR/install-aelix-studio-web.sh" ;;
  *) echo 'Mirrors must use HTTPS or a local file:// path' >&2; exit 1 ;;
esac

export HOME="$SMOKE_DIR/home"
mkdir -p "$HOME"
install_dir="$HOME/.local/share/aelix-studio-web"
link="$HOME/.local/bin/aelix-studio-web"
# Let the release script read its embedded version and use its default paths.
env -u VERSION -u INSTALL_DIR -u BIN_DIR -u CREATE_SYMLINK -u UPDATE_PATH \
  bash "$INSTALLER" --mirror "$MIRROR" --no-path

[[ -L "$link" && "$(readlink "$link")" == "$(realpath "$install_dir/aelix-studio-web")" ]]
[[ "$("$link" version)" == "$VERSION" ]]
if [[ "$(uname -s)" == Linux ]]; then
  test -f "$install_dir/aelix-studio-web.service"
fi
bash "$SCRIPT_DIR/smoke-test-web-cli.sh" "$install_dir" "$link"

rm -- "$link"
rm -rf -- "$install_dir"
test ! -e "$install_dir"
test ! -L "$link"
echo 'Studio WebUI was installed, launched through its symlink, and removed.'
