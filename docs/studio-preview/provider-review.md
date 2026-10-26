# Studio #5 independent review

2026-10-25. A separate Codex review session (`provider_review`) reviewed the
implementation in the issue-specific worktree against the accepted ACP #7
management contract and unchanged public native beta.2 APIs. It did not edit
implementation files or other worktrees. The reviewed base is
`aa6b07190d1eea8f8177ed4e6e8911389837fdde`.

## Findings and resolution

- The first desktop IPC guard accepted the main frame of any BrowserWindow even
  after it navigated to an external HTTP page. The reviewer reproduced that
  preload exposure on Electron 37. The implementation now registers only the
  Studio main window with its exact packaged file/configured dev URL, checks the
  sender/frame/URL on each request, and cancels its owner on document navigation
  or destruction. The author then verified rejection through actual external
  navigation in the final host smoke.
- The helper's newly authored manual OAuth input instruction was hardcoded in
  English. It now emits a typed `manual` prompt; the renderer localizes the label
  in all 13 supported locales. External native Provider prompt text remains
  transient source data.
- Author follow-up found that EOF while native OAuth waited without an input
  prompt could outlive the parent. The final helper uses one stdin reader, a
  reply queue and EOF event raced against native login, then cancels/gathers all
  tasks before returning/committing. A new standalone native fixture verifies
  EOF during a remote wait. The reviewer independently inspected and reran it.

The final review reports **no remaining actionable findings**. It also checked
configured versus remote acceptance, the explicit CLI root, stale worker caches,
legacy concurrent mutation limits, credential logging/replay avoidance, callback
ownership, deadlines, sidecar/revision boundaries, terminal secret cleanup and
cancellation status refresh. The public wheels were not patched.

## Independent reruns

The final independent rerun used supported Node `24.19.0`, disposable HOME/auth
and output roots, and cleared inherited Provider credentials/routing:

- Four focused Vitest files: **44 passed**.
- Standalone public-wheel helper qualifier: **10 checks passed**.
- i18n validation: **passed**.

The reviewer did not rerun the full suite, coverage or complete Electron/WebUI
qualifier. Those remain author evidence in [provider-acceptance.json](provider-acceptance.json):
5,010 Vitest passed/5 skipped, six Python baseline tests, actual host checks,
source/build hashes and a no-match log/transcript/DB sentinel scan. There is no
claim of real Provider/OAuth, additional host OS, installer or field acceptance.

This review and the local commit do not authorize or establish push, PR, merge,
remote CI, publication or closure of the cross-surface acceptance Issue.

## Installer follow-up review

The user subsequently authorized real-account/installer acceptance and push/PR.
A separate review of the follow-up found stale cached payload reuse, missing
installed ACP re-audit and absolute internal symlink preservation. The builder
now binds current recipes/baseline/prepared receipt, checks exact file and symlink
inventory, rechecks the accepted installed ACP identity, and rejects absolute or
escaping links. Global site injection is refused and owned launches use `-I -S -B`.
The separate credential-root fact is no longer treated as proof of fresh OAuth;
real browser enrollment has its own observed callback/token-exchange receipt.

Final independent follow-up reruns on Node 24: 17 service/facade tests, all nine
Python preview tests, and the current payload's `--verify-only` passed. No remaining
production blocker was reported. Installed UI/real-account/full-suite/coverage
checks remain author evidence. The WebUI harness scope is explicitly source facade
and helper with an installed backend, not the compiled app-owned WebUI listener.

## CI Python selection follow-up

The first installer CI attempt on `89bee90` selected the runner's system Python
3.12, whose global site contained extra packages. The bundle guard correctly
refused that base. Preparation now installs an owned uv-managed standalone
Python and passes its exact executable to both virtual environments. The global
site guard remains unchanged. Fresh local preparation passed all six native and
four adapter checks; a new payload passed the existing bundle guard and both
bundled entrypoints launched successfully.

The separate reviewer found no actionable issue in this fix and independently
passed all 12 Python preview tests, including ambiguous installations, the minor
version symlink alias and an escaping interpreter. Remote CI is recorded on the
PR checks; these local observations do not establish a successful remote rerun.

The next remote run on `8993cfc57` passed preparation and DMG assembly, then
strict signature verification rejected the installed app. electron-builder had
skipped signing because it detected a pull request. The installer build step now
enables signing for PRs explicitly. Its dedicated builder still fixes the
identity to ad-hoc `-`, disables notarization/publication and uses no signing
credentials; normal release/build jobs are unchanged. The acceptance script
retains strict deep signature verification before launching the app.

## Five-target follow-up review

A separate read-only Codex session reviewed the all-platform follow-up on main
`95050d31956b3fe172fea5916ef530ea1501cfd6`. It found and rechecked fixes for:

- Windows credential writes could preserve an unsafe existing `auth.json.tmp`
  DACL or untrusted owner. The helper checks root/auth/native temporary/model/
  sidecar ownership and DACLs, rechecks before OAuth commit and verifies the
  published file. A Windows-only process regression rejects an Everyone-readable
  native temporary file without modifying credentials or that file.
- ASAR inventories use Windows path separators. The installed-code check now
  normalizes separators and compares the exact renderer JavaScript inventory.
- Helper `python.exe` launches now hide the console window.

The reviewer reported no remaining actionable P1/P2 blocker in the reviewed
helper/runtime/launcher/preparation/bundle/installer/CI source. Independent Node
24 reruns passed 35 focused tests initially and 21 affected auth/service/facade/
runtime tests after the final helper spawn change; Python preview tests passed
18/18. The embedded installed probe compiled and diff whitespace checks passed.
No implementation files, other worktrees or operator credentials were changed.
Actual Windows ACL/installer behavior and the five installed-runtime flows still
require their remote runner receipts; this macOS review does not establish them.

Author local full tests passed 5,015 with five skipped. The coverage command
passed, reporting 54.33% overall statements (existing repository target shortfall;
no claim of 80% repository coverage). Focused runtime source coverage was 100%
statements; the Python helper's string coverage does not prove its runtime
behavior. Actual process and installer qualification remains separate evidence.

The macOS installed host raw hash changes during ad-hoc signing. The current
identity guard retains the exact public raw hash before packaging and compares
code through a deterministic thin64 Mach-O parser. It validates the complete
LINKEDIT extent and a single final16-byte signature command, terminal signature
payload and SuperBlob/index/blob bounds. It clears only that command slot and
header counts, retains all mapped offsets/ordinary commands/body bytes, adds
zero signing alignment to16 bytes and normalizes LINKEDIT extent/allocation
metadata. Nonzero alignment changes still change the hash. Other platforms
retain raw byte identity. Strict installed app signature verification remains.

An earlier implementation removed signatures on private copies with the local
codesign tool. Intel CI reported a mismatch even though the downloaded actual
unsigned public Intel core and signed installer matched locally after signature
removal. That remote cause is not claimed as established. The pure parser avoids
host-tool normalization and now records separate raw-source/code failures and
structural diagnostics without credentials. Independent23 Python regressions,
an independently ad-hoc-signed owned Intel core and actual public/installed ARM
cores matched. The author also matched the actual downloaded Intel DMG code
against its public unsigned artifact. Signed-file raw equality is not claimed.

The author installed the macOS arm64 DMG:12 UI checks, restricted GUI PATH,
exact compiled-code inventory,309 unchanged native wheel members and owned app
removal passed. Actual OpenRouter and existing Codex credential first/restart
responses passed from the same packaged build without changing CLI auth.

The first Windows installer job stopped at the ZIP regression fixture: CPython
normalizes Windows separators in `ZipInfo.filename`. The extractor now checks
`orig_filename` before accepting the normalized path, and the fixture explicitly
preserves its hostile archive spelling. Independent review found no actionable
issue and reran all20 Python tests successfully. Windows remote rerun remains
required; the original failed job is not accepted as installer evidence.

The first Windows installed qualification reached NSIS installation and bundled
Python/ACP probes, then its hostile-ACL fixture passed an unsigned generic-rights
value outside pywin32's signed C-long range. The fixture now uses
`FILE_READ_DATA` (1), verified in the pinned pywin32 wheel, still granting Everyone file-read access; the production
ACL boundary is unchanged. Review confirmed the fixture exercises the same
confidentiality rejection. The installed qualification now runs callback/EOF/ACL
regressions through the actual selected bundled payload, validates its manifest
against prepared provenance, binds the helper receipt to that manifest and
compares every selected payload file before/after. Prepared wheel verification
and installed app runtime discovery remain separate and mandatory. Both old
receipts are invalidated on preflight failure. Independent review passed Python
20 tests before the added receipt-invalidation regression; target CI remains
required. The Intel DMG attempt failed at a resource-busy volume detach before
installation; no forced unmount or alternate format was used to claim success.

The prepared-helper CI preflight now runs before installer assembly to catch
platform fixture/API regressions early; it does not replace the final installed
bundled-helper qualification. The Windows fixture's named constant was in a
different module, so the final fixture uses the verified minimal FILE_READ_DATA
bit1 directly. No production ACL check was relaxed. Author Python23 tests passed;
remote target reruns remain required.

The new Windows preflight exposed8.3 versus long temporary-directory spellings:
JavaScript's non-native realpath preserved the short spelling while Python
resolved it. Both compared roots and the owned preflight sandbox now use the
OS-native realpath binding. Independent review confirmed exact directory equality
is retained; no product path or ACL boundary changed. Full5,015 tests passed.
Actual Windows confirmation remains a remote-CI requirement.

The latest full run passed14 of15 jobs, including installed Intel acceptance;
Windows prepared and installed bundled helpers each passed all12 regressions.
The Windows UI harness then failed before the user-flow checks because asar3.4.1
splits extraction names using the host path separator. Both extraction calls
now normalize the relative name with the native path API. Exact byte hashes
and renderer inventory equality remain mandatory. A real asar create/extract
fixture now runs in preflight before packaging. Local archive probe, Python23
and full5,015 tests passed; Windows UI acceptance still requires the new run.
