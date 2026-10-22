# Aelix Studio distribution implementation

Verified 2026-10-23 (Asia/Seoul), macOS Apple Silicon.

## Delivered locally

- Branded Electron/PWA shell and icons; app ID `ai.aelix.studio`, protocol
  `aelix-studio://`, independent data paths and GitHub update feed/downloads.
- Aelix Coding seeded through unmodified AionCore Custom Agent API and its generated assistant catalog;
  default fresh-chat selection and saved/disabled preference handling.
- Host-native Python 3.12.12 + Aelix 0.1.0b2 + ACP 0.1.0 bundle. ACP source:
  `71eabb42b3c97e089e7d8601bc32b310ee40dbea` in `handochan/aelix-acp`.
- Native distribution command `bun run studio:dist`, runtime manifest/hash lock,
  byte inventory, packaging missing-runtime gate, and runtime smoke command.
- Original upstream LICENSE and copyright headers retained; downstream NOTICE.

## Verification

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

## Acceptance boundaries

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
