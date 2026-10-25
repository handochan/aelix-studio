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
