#!/bin/bash
set -euo pipefail

PACKAGE=${1:?Usage: $0 <tarball-or-installed-directory> [installed-link]}
CLI=${2:-./aelix-studio-web}

echo "========================================"
echo "Smoke test for web-cli tarball"
echo "========================================"
echo "Package: $PACKAGE"

# 1. Extract tarball
echo ""
echo "1. Extracting tarball..."
TEMP_DIR=$(mktemp -d)
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT
if [ -d "$PACKAGE" ]; then
  cd "$PACKAGE"
else
  tar -xzf "$PACKAGE" -C "$TEMP_DIR"
  cd "$TEMP_DIR/aelix-studio-web"
fi

# 2. Verify directory structure
echo ""
echo "2. Verifying directory structure..."

# New layout (bun compile standalone binary):
#   aelix-studio-web/
#   ├── aelix-studio-web           ← single compiled executable (no bin/, no dist/, no node_modules)
#   ├── package.json         ← for version lookup
#   ├── static/              ← SPA assets
#   └── bundled-aioncore/<plat-arch>/...
for dir in static bundled-aioncore; do
  if [ ! -d "$dir" ]; then
    echo "❌ Missing $dir directory"
    exit 1
  fi
  echo "✓ Found $dir/"
done

if [ ! -f "package.json" ]; then
  echo "❌ Missing package.json"
  exit 1
fi
echo "✓ Found package.json"

# 3. Check executable
echo ""
echo "3. Checking executable..."
if [ ! -x "aelix-studio-web" ]; then
  echo "❌ aelix-studio-web is not executable"
  exit 1
fi
echo "✓ aelix-studio-web is executable"

# 4. Test version command
echo ""
echo "4. Testing version command..."
VERSION=$("$CLI" version)
if [ -z "$VERSION" ]; then
  echo "❌ version command returned empty"
  exit 1
fi
echo "✓ Version: $VERSION"

# 5. Test backend binary
echo ""
echo "5. Checking backend binary..."
BACKEND_DIR="bundled-aioncore/$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')"
BACKEND_BINARY="$BACKEND_DIR/aelix-studio-host"
if [ ! -x "$BACKEND_BINARY" ]; then
  echo "❌ Backend binary missing or not executable: $BACKEND_BINARY"
  exit 1
fi
# aioncore has no --version flag. Read the pinned version from manifest.json
# (which prepareAioncore writes at pack time) and use --help to confirm the
# binary loads successfully on this platform's GLIBC / libstdc++ / etc.
if [ -f "$BACKEND_DIR/manifest.json" ]; then
  BACKEND_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$BACKEND_DIR/manifest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  echo "✓ Backend version (from manifest): ${BACKEND_VERSION:-unknown}"
fi
if ! "$BACKEND_BINARY" --help > /dev/null 2>&1; then
  echo "❌ Backend binary failed to exec (--help returned non-zero)"
  "$BACKEND_BINARY" --help 2>&1 | head -5
  exit 1
fi
echo "✓ Backend binary loads on this platform"

# Exercise the extracted CLI and its bundled host with a fresh data directory.
DATA_DIR="$TEMP_DIR/data"
IGNORED_DATA_DIR="$TEMP_DIR/ignored-data-dir"
webui_curl() {
  curl --noproxy '*' "$@"
}
start_webui() {
  AIONUI_DATA_DIR="$IGNORED_DATA_DIR" "$CLI" start --no-open --port 0 --data-dir "$DATA_DIR" >"$TEMP_DIR/webui.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 45); do
    BASE_URL=$(sed -n 's/^  Local  : //p' "$TEMP_DIR/webui.log" | head -1)
    if [ -n "$BASE_URL" ] && webui_curl -fsS "$BASE_URL/" >"$TEMP_DIR/index.html"; then
      grep -q '<html' "$TEMP_DIR/index.html"
      test -d "$DATA_DIR/logs"
      test ! -e "$IGNORED_DATA_DIR"
      return
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    sleep 1
  done
  echo "WebUI did not start" >&2
  exit 1
}
stop_webui() {
  kill "$SERVER_PID"
  wait "$SERVER_PID"
  SERVER_PID=""
}
login() {
  printf '{"username":"admin","password":"%s","remember":false}' "$1" |
    webui_curl -fsS -c "$TEMP_DIR/cookies" -H "Origin: $BASE_URL" -H 'Content-Type: application/json' \
    --data-binary @- "$BASE_URL/login" >"$TEMP_DIR/login.json"
  grep -q '"success":[[:space:]]*true' "$TEMP_DIR/login.json"
  grep -q 'aelix-studio-session' "$TEMP_DIR/cookies"
}

start_webui
PASSWORD=""
for _ in $(seq 1 20); do
  PASSWORD=$(sed -n 's/.*Generated initial admin password: //p' "$TEMP_DIR/webui.log" | head -1)
  if [ -n "$PASSWORD" ]; then break; fi
  sleep 1
done
test -n "$PASSWORD"
login "$PASSWORD"
webui_curl -fsS -b "$TEMP_DIR/cookies" -o /dev/null "$BASE_URL/api/auth/user"
HTTP_CODE=$(webui_curl -sS -H 'Origin: http://example.invalid' -H 'Content-Type: application/json' \
  --data '{}' -o /dev/null -w '%{http_code}' "$BASE_URL/login")
test "$HTTP_CODE" = "403"
echo "✓ First launch and browser login"

if "$CLI" resetpass --data-dir "$DATA_DIR" --password-stdin </dev/null >"$TEMP_DIR/reset.log" 2>&1; then
  echo "Reset unexpectedly succeeded while WebUI was running" >&2
  exit 1
fi
grep -q 'Stop WebUI before resetting its password' "$TEMP_DIR/reset.log"
stop_webui

NEW_PASSWORD='Synthetic-offline-reset-Pass123'
printf '%s\n' "$NEW_PASSWORD" |
  AIONUI_DATA_DIR="$DATA_DIR" "$CLI" resetpass --password-stdin >"$TEMP_DIR/reset.log" 2>&1
start_webui
HTTP_CODE=$(webui_curl -sS -b "$TEMP_DIR/cookies" -o /dev/null -w '%{http_code}' "$BASE_URL/api/auth/user")
test "$HTTP_CODE" = "401"
login "$NEW_PASSWORD"
stop_webui
echo "✓ Running reset refused, offline reset revoked the prior session, new password accepted"
