# Windows x64

The Studio native runtime supports Windows x64 build hosts. This is an implemented
build path, not a claim of completed installer or Windows UI acceptance. The
`windows-2022` jobs in `.github/workflows/aelix-studio.yml` prepare the runtime,
exercise permissions, build an NSIS installer and smoke-test its packaged runtime.
Those jobs must actually pass on the reviewed commit before claiming Windows delivery.

## Build

Install Node 22–24, Bun 1.4.4, Python 3.9+ (`python` on PATH), and uv 0.11.19.
Use a native x64 Windows shell. The Studio/ACP launch path uses no Git Bash or
`/bin/sh`; individual Aelix tools retain their own Windows prerequisites.

```powershell
bun install --frozen-lockfile
bun run studio:dist
```

`studio:dist` prepares Python/Aelix/ACP and the pinned AionCore backend before
packaging. To prepare or verify just the runtime:

```powershell
python scripts/aelix-studio/prepareRuntime.py
python -m unittest discover -s tests/studio -p "test_*.py"
python scripts/aelix-studio/smokeRuntime.py --relocate
# After packaging:
python scripts/aelix-studio/smokeRuntime.py out/win-unpacked/resources/bundled-aelix/win32-x64 --relocate
```

The Python tests require the prepared runtime and Python 3.12; alternatively run
them with `resources/bundled-aelix/win32-x64/python/python.exe -I -m unittest ...`.

The app registers `python/python.exe -I launch.py acp` as an executable plus an
argument array. ACP launches its child with the same bundled Python. Spaces and
non-ASCII paths do not pass through a command shell. Trusted wheel `.pth` files
are processed for pywin32 DLL/import paths; user Python environment variables are
ignored. The universal dependency lock includes Windows-only colorama/pywin32.

## Approval transport

The pinned ACP source has a small, fail-closed compatibility patch under
`scripts/aelix-studio/compatibility/`. Its hashes are recorded in the runtime
manifest alongside the original ACP commit/archive checksum.

Windows binds only `127.0.0.1` on an ephemeral TCP port. Every session receives a
random 256-bit token; a request without the correct token never reaches the ACP
client. Missing connections, malformed messages, client rejection, cancellation
and client failures deny execution. Tool arguments and tokens stay on the local
channel. This protects against unauthenticated local connections; it is not an
OS sandbox against another process with access to the same user's environment.
POSIX retains its private Unix socket and also validates the token.

## Installer corrections and acceptance

NSIS executable checks now use the product filename instead of `AionUi.exe`.
Installer reports receive an empty Sentry DSN even if a build shell has one set.
The build script fails on locked output instead of killing all Electron/AionUi
processes on the machine.

Before release, run the actual installer with the following conditions: clean
install, upgrade/reinstall, uninstall, installation path with spaces/non-ASCII
characters, Aelix session creation and tool allow/reject/cancel. Verify that an
existing AionUi install and data remain independent. Signed installer publication
is separate from local packaging. Windows arm64 is not enabled in the Studio
runtime target list.
