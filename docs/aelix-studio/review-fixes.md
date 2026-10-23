# Review corrections — 2026-10-23

Corrections to the reviewed `4c65a339410fb63cd941d9ac40a86423b3d6da78` bootstrap.
The release scope is Windows x64, Linux x64/arm64, macOS x64/arm64, single-operator
WebUI, Coding, Analytics and inherited agent teams. Corporate IdP SSO is deferred.

## Changes

| Review item                | Correction                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows Python preparation | Select the exact patch-version installation, excluding uv's minor-version junction alias; disable Python registry registration.                                                                                                                  |
| Large approval requests    | Use a bounded 16 MiB channel on TCP and Unix sockets; distinguish channel failures from user rejection and suppress teardown connection errors.                                                                                                  |
| Docker persistence         | Persist Aelix settings and JSONL sessions alongside the backend and ACP indexes under `/data`.                                                                                                                                                   |
| Repeated agent updates     | Skip unchanged entries; preserve additional arguments, advanced settings and the protected environment overrides used by Agent Settings.                                                                                                         |
| Hidden bootstrap failures  | Await profile registration before marking the app ready; preserve the failure dialog and await recovery before reloading.                                                                                                                        |
| Paths containing spaces    | Use the unchanged backend's managed Node resolver and a small native-argument bridge to Python. The v0.2.2 custom-agent probe splits executable names on whitespace, including quoted names.                                                     |
| Analytics integration      | Bundle checksum-pinned Analytics 0.26.0, uv 0.11.19 and a locked dependency cache. Each project retains its own Python environment.                                                                                                              |
| Team integration           | Enable the existing `supports_team` capability for Coding and Analytics; reuse the backend's MCP/CLI transport selection.                                                                                                                        |
| WebSocket proxy            | Inspect complete handshakes, reject forged internal headers and non-upgrades, and do not relay queued client bytes before a 101 response. This is defense in depth; an actual authentication bypass was not established.                         |
| Disabled feedback UI       | Hide report entry points and prevent screenshot collection while online feedback is disabled.                                                                                                                                                    |
| Product attribution        | Update tray/install messages, About/help links and provider headers; retain the upstream updater license header and package LICENSE/NOTICE.                                                                                                      |
| Delivery workflows         | Run Studio checks on main, the implementation branch and version tags; add native runtime and packaged-desktop jobs for five targets. Prepare Studio resources in manual builds and guard inherited upstream publishing/organization automation. |

The management API intentionally redacts base environment values. Operator secrets
belong in Agent Settings' `/api/agents/{id}/overrides` channel, which the refresh
does not replace. Direct edits to Studio-owned base metadata are not a secret
provisioning interface.

## Verification commands

Use Python 3.12 or the bundled interpreter for tests; the preparation driver itself
supports build-time Python 3.9+. Local command results are recorded in the current
section of [distribution-status.md](distribution-status.md).

```sh
bun run lint:fix
bun run format
bun x tsc --noEmit
bun run i18n:types
node scripts/check-i18n.js
bun run test
python scripts/aelix-studio/prepareRuntime.py
python -m unittest discover -s tests/studio -p 'test_*.py'
python scripts/aelix-studio/smokeRuntime.py --relocate
bun run studio:dist
E2E_PACKAGED=1 bun x playwright test tests/e2e/specs/app-launch.e2e.ts
actionlint -shellcheck='' .github/workflows/*.yml
docker build -t aelix-studio:review .
```

`test_bootstrap.py` runs the current TypeScript bootstrap against a real isolated
AionCore: two profiles are registered, unchanged startup performs no PUT, settings
survive relocation through a path with spaces/non-ASCII text, and a team is created
with Coding and Analytics runtimes attached. Runtime-only jobs without a backend
skip this host check; packaged-desktop jobs set `STUDIO_REQUIRE_HOST_TEST=1` so a
missing prerequisite fails the job instead of silently skipping it.

`test_analytics.py` initializes an independent project and generates synthetic
analysis and HTML with network access disabled in uv and no tools on PATH except
the bundle. This is synthetic acceptance, not real-source/model acceptance.

The Docker job additionally records an actual ACP session, replaces the container
while retaining its volume, verifies a settings fixture and the original JSONL
bytes, and loads that session through the bundled adapter.

## Evidence boundaries

The original exact-head remote run [39869539859](https://github.com/handochan/aelix-studio/actions/runs/39869539859)
passed quality, macOS/Linux runtime and offline WebUI checks and failed both
Windows jobs during Python preparation. That result does not validate these
subsequent corrections. The corrected commit `30e74b16c` was pushed and its
[run 39911177099](https://github.com/handochan/aelix-studio/actions/runs/39911177099)
passed all five native-runtime jobs, both Linux desktop jobs, quality and offline
WebUI. macOS packaging hit Node's default heap limit; Windows host-test cleanup
left descendant processes writing into its temporary directory. The follow-up
raises the build heap limit and stops the owned Windows process tree. See
[distribution-status.md](distribution-status.md) for the exact evidence and
remaining checks; these follow-up changes still require their own completed run.

Installer upgrade/uninstall, signed public release/update installation, real
provider-backed team delegation and customer data acceptance remain distinct
from runtime, desktop-launch and synthetic-analysis checks.
