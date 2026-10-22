# Aelix Studio distribution implementation

## Follow-up — 2026-10-23 (Asia/Seoul)

Implemented locally on top of `b1287115cb16c596815da4a82f469277bcfadc2d`.
No push, remote CI execution, main merge, tag or release publication is implied.
The app version remains inherited **2.2.2**.

- Windows x64 native build/packaging path, direct bundled Python execution,
  universal hash-locked dependencies including colorama/pywin32, and authenticated
  loopback approval transport. ACP compatibility changes are recorded separately
  from the unchanged pinned source archive in each runtime receipt.
- NSIS product-executable verification corrected, installer Sentry DSN disabled,
  and build-wide Electron process killing removed.
- Standalone WebUI now provisions privately before starting a backend with
  authentication enabled. This fixes inherited `--local` API authentication bypass.
  The login SPA loads correctly, internal browser headers are stripped, and
  unauthenticated desktop-backend LAN sharing is disabled.
- WebUI startup uses bundled managed resources instead of downloading Node.
  Docker now builds and starts the actual standalone host with bundled Aelix;
  WebUI/reset-password data defaults use Studio-owned paths.
- Disabled Sentry, stable diagnostics identifiers, startup log uploads, build
  source-map uploads, online feedback collection/submission, and automatic update
  checks. Replaced the HTML editor CDN path with bundled CodeMirror and automatic
  remote Markdown images with explicit links. Browser passwords are no longer saved.
- Replaced main/Korean READMEs with Studio documentation. Upstream tracking records
  a compare URL and JSON artifact; `--fail-on-drift` fails the review gate on tag/SHA drift.

### Follow-up verification

| Check                                            | Result                                                                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full Vitest suite                                | **527 files passed, 1 skipped; 5,017 tests passed, 5 skipped**                                                                                      |
| Python permission/integrity regression tests     | **14 passed**; real TCP/Unix sockets, consent, reject, wrong/missing token, cancellation and channel failure                                        |
| TypeScript / lint / formatting / i18n            | Passed; existing lint warnings remain, zero errors                                                                                                  |
| Production Electron main/preload/renderer bundle | Passed; inherited large-chunk warning remains                                                                                                       |
| Native macOS arm64 relocated runtime             | Real ACP initialize and Aelix session/new succeeded with empty user state, unavailable tools on PATH and invalid Python environment; clean shutdown |
| Packaged macOS arm64 app                         | `afterPack` resource gates, relocated real ACP session, and `codesign --verify --deep --strict` passed; ad-hoc signature only                       |
| Windows x64 dependency planning                  | Hash-locked binary-wheel resolution passed; this does not execute Windows binaries                                                                  |
| Browser login against real AionCore              | Login and authenticated user/agent requests succeeded; bundled Aelix registered; password/username absent from browser storage                      |
| Browser network observation                      | No external page origins during the measured login/home flow; not a whole-product egress proof                                                      |
| WebSocket authentication                         | Missing credentials produce `REALTIME_AUTH_MISSING` and close code 1008; authenticated connection upgrades successfully                             |
| Standalone API authentication                    | Login GET 200, unauthenticated user/agent API 401, forged internal header 401                                                                       |
| Linux arm64 Docker                               | Image built locally; `--network none` startup, login, authenticated APIs and bundled Aelix registration passed                                      |
| Linux arm64 relocated runtime in Docker          | Real ACP/Aelix session created with `--network none`                                                                                                |
| Password reset CLI                               | Cold reset against a fresh Studio-only test data directory succeeded in bundled-resource mode                                                       |
| Latest stable AionUi                             | Live GitHub comparison: **v2.2.2 / 6744099b279b991c17e31c243f0920477bd31cb6**, unchanged                                                            |

Local evidence is intentionally ignored under `.local/studio-followup-*`: full test
and build logs, permission tests, runtime receipts, Windows resolution plan,
upstream JSON, browser screenshots/report, and Docker build/auth/login/runtime
reports. Private WebUI logs contain disposable test credentials and are not committed.

### Acceptance still required

Windows x64 execution, installer/UI, upgrade/uninstall and real tool execution are
**not verified on this macOS host**. Windows/macOS/Linux runtime jobs, a Windows
installer job and disconnected Docker smoke job are configured but have not been
pushed or executed remotely by this task. Windows arm64 remains unsupported by
this bundle. Linux x64 and macOS x64 have no new native acceptance here.

Internal model/provider deployment, optional preview/tool behavior and complete
closed-network operation still require the operator's real configuration.
Signed/notarized public installers, release/update publication, and enterprise
multiuser isolation are not delivered by these changes. See
[self-hosting.md](self-hosting.md) for the reviewed network inventory and
[windows.md](windows.md) for the implemented Windows path.

---

## Original macOS distribution evidence

Earlier verification on 2026-10-23 (Asia/Seoul), before the follow-up below.
The original model-call and packaged-UI evidence is historical, not a repeat
acceptance of the follow-up changes.

### Originally delivered locally

- Branded Electron/PWA shell and icons; app ID `ai.aelix.studio`, protocol
  `aelix-studio://`, independent data paths and GitHub update feed/downloads.
- Aelix Coding seeded through unmodified AionCore Custom Agent API and its generated assistant catalog;
  default fresh-chat selection and saved/disabled preference handling.
- Host-native Python 3.12.12 + Aelix 0.1.0b2 + ACP 0.1.0 bundle. ACP source:
  `71eabb42b3c97e089e7d8601bc32b310ee40dbea` in `handochan/aelix-acp`.
- Native distribution command `bun run studio:dist`, runtime manifest/hash lock,
  byte inventory, packaging missing-runtime gate, and runtime smoke command.
- Original upstream LICENSE and copyright headers retained; downstream NOTICE.

### Original verification

- Full Vitest suite: **523 files passed, 1 skipped; 4,995 tests passed, 5 skipped**.
- TypeScript, lint (zero errors), formatting, i18n types/validation, production
  Electron main/preload/renderer build.
- Real AionCore API: repeat registration leaves exactly one owned engine and
  one generated preset. Existing user agent with the same name is protected by unit tests;
  disabled preset, relocated paths and backend failure have focused coverage.
- Runtime copied to a directory containing spaces with a restricted PATH,
  invalid PYTHONPATH/PYTHONHOME and empty HOME: real ACP initialize/session/new
  succeeds, including actual Aelix child startup and approval-bridge ready check.
- Packaged runtime inside `out/mac-arm64/Aelix Studio.app/Contents/Resources`
  passes the same real session creation check.
- Packaged app: unaltered official Aelix mark/wordmark lockup for the active theme, default selected Aelix, isolated test
  userData, app ID and ad-hoc signature (`codesign --verify --deep --strict`).
- Packaged UI real model call: configured OpenRouter / DeepSeek V4.1 Flash 1017
  returned `STUDIO_RUNTIME_OK` through the bundled Aelix. Screenshot evidence:
  `.local/studio-packaged-response.png` (synthetic prompt, no tool call).
- Official lockup UI verification: light/dark assets render identically to their
  canonical SVGs at 140×40, preserving the 3.5 aspect ratio without CSS filters
  or transforms. Evidence: `.local/wordmark-qa.json`,
  `.local/aelix-wordmark-light.png`, `.local/aelix-wordmark-dark.png`.
- ACP remote CI on the pinned commit passed macOS/Linux × Python 3.11/3.12:
  [run 39818697532](https://github.com/handochan/aelix-acp/actions/runs/39818697532).

Ignored local evidence: `.local/studio-all-tests.log`, `studio-typecheck.log`,
`studio-lint.log`, `studio-build.log`, `studio-pack.log`, `studio-registration.json`,
`studio-clean-runtime.json`, `studio-packaged-runtime.json`, `studio-ui-result.json`,
`studio-packaged.png`. These are local evidence, not committed or remote CI.

### Original acceptance boundaries

This is a local macOS arm64 development distribution, approximately 1 GB as an
uncompressed app bundle. It is ad-hoc signed; Developer ID signing, notarization,
DMG/release publication and a verified auto-update round trip are not delivered.
The app/package version remains the inherited 2.2.2, not a new Studio release.
No main merge, tag or GitHub release is implied by a development branch push.

Only Coding is bundled/seeded. Analytics is still optional. Team delegation,
SSH, extension management, advanced ACP model/thinking/slash control, preview
bug fixes, enterprise multiuser/offline product acceptance and Windows permission
transport remain separate work. No provider credential or Analytics environment
is included in the runtime. Package preparation needs network access on the build
machine; installed Python/Aelix/ACP binaries do not need package downloads.
