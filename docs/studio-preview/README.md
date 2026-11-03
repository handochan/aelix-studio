# Studio #28 Beta candidate baseline — host `aelix.2`

Current executable pins are in [baseline.json](../../scripts/studio-preview/baseline.json).
The historical Preview evidence below describes older commits and public beta.2 wheels.
It does not establish acceptance for this candidate or for the public joint Beta.

| Component               | Exact source / archive SHA-256                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Studio base             | `ce98f677a41e7f34c5f7f1609508b7e96289f5f2`                                                                                    |
| Host                    | `host-v0.2.2-aelix.2`, commit `2e1c31006bc0429324e0c37e222575dcdb06b1a2`                                                      |
| Host provenance         | `c76e162fe1c3659234abc43739f1df11591b33e4ebca9013aee58cdd98fb0439`                                                            |
| Native beta.3 candidate | `e19ab55e17e871a40356fc9802f3f6669ca727de`; source archive `c6088edb122c8e3dec4b954e104bf12ff4db749674b6d540b70c5ac5b1ebf997` |
| ACP                     | `16d6555b08825d1d63c3b082de2b10a1152562c0`; source archive `6d4b9e4c918ca51345b4b39ff93e31141a4f31decd67f628b7a54c496078c111` |

The native source still declares `0.1.0b2`. Studio builds its four wheels without patches,
using the exact candidate source, a fixed build timestamp and declared build constraints.
These are **candidate source wheels**, not public beta.2 or beta.3 wheel evidence. The ACP
runtime reference must match that exact native commit and its pinned file hash. Preparation
records each produced wheel hash, the native source inventory, installed ACP package hashes,
Python provenance, dependency lock and host release identity in `.local/studio-preview/receipt.json`.
The relocatable payload retains these pins and validates original wheel members after install.

Host archives for all five targets and their release smoke results are pinned in
[host policy](../../scripts/studio-preview/host-release/default.json) and the byte-preserved
[release provenance](../../scripts/studio-preview/host-release/provenance.json). Studio
verifies archive SHA-256 before extraction/execution, retains `LICENSE` and `NOTICE`, and
checks installer-stable code identity. Managed Node is prepared at build time by the released
host. No upstream source download, Rust build, permission patch or forwarding patch runs.
The host retains `AIONCORE_LISTENING`, `AIONCORE_READY`, `.aioncore.log`, exit 3 /
`BOOTSTRAP_PEER_ALREADY_RUNNING`, `AIONCORE_BOOTSTRAP_SECRET`, `x-aioncore-bootstrap-secret`,
`AIONUI_*`, existing data directories and `aionui-backend.db`.

For an internal database that has migration **044** from #25: stop Studio and its host,
back up the entire owned internal test data directory (including SQLite sidecars), then
start this candidate with a **fresh data directory**. Do not reuse or automatically downgrade
that database. Also use a fresh internal browser profile: old #25 queue/localStorage operation
bindings are retired. Preserve native CLI auth and session files; this reset concerns Studio's
internal test state only. This is not a public upgrade/migration path.

With a 044 internal database, the aelix.2 host (migrations through 043) reports sqlx
`VersionMissing(44)` as `database.newer_than_app`. The inherited screen says
“A newer version of AionUi is required … no reinstall or data reset is needed”.
For this internal #25 rollback, **that message requires a fresh Studio data directory,
not an update**: stop the app/host, back up the owned test state, and follow the reset
instructions above. No screen branch or public upgrade policy is added.

Reproduce on a supported native runner (Node 22+, Bun, Python, uv **0.13.5**):

```sh
python -B scripts/studio-preview/prepare.py --target darwin-arm64
node scripts/studio-preview/packaging/build.mjs --runtime .local/studio-preview
.local/studio-preview/native/bin/python -B scripts/studio-preview/packaging/acceptance.py --runtime .local/studio-preview
```

Use `Scripts/python.exe` on Windows and `xvfb-run -a` for Linux acceptance. PR Checks runs
this path on darwin arm64/x64, Linux arm64/x64 and Windows x64. The actual installed app
checks first response, Ask/Yolo recovery and full process restart without a backend override.
The Provider smoke also opens authenticated LAN HTTP WebUI in an ordinary sandboxed
Chromium window without preload, verifies insecure-context Web Locks absence, and sends
through the existing UI. This LAN evidence covers the **source web-host library serving
the built renderer on a LAN address with the installed backend**. The installed app’s
own WebUI listener was not started or qualified. All model/credential inputs are
synthetic loopback fixtures.
Independent review belongs to the separate Claude coordination session.

The initial [ownership map](../studio-release-train/README.md#모듈-소유권-map-초판--studio-28-aelix2)
records native/ACP/host/Studio authority and the retired #25 path.

Issue #28 remains open for `aelix.3`: after PR #34 is merged, use a new PR on the same
Issue for the release containing host PRs #12/#15. Advance
the pin, remove direct remote-image fallback, add four error-code locales/display and
`protocol_code`/`data` handling, and forward the agreed host environment settings.
Those behaviors are intentionally outside this PR. No main push, tag, release or merge occurs.

---

# Studio #4 public beta.2 baseline

This is the reproducible qualification path for [Studio #4](https://github.com/handochan/aelix-studio/issues/4),
based on the accepted [ACP #6 handoff](https://github.com/handochan/aelix-acp/issues/6#issuecomment-6390054201).
It prepares disposable installed wheels and runs the actual built Studio Electron
renderer and AionCore against a synthetic loopback model. It does not produce a
release bundle or enable these agents in an operator's existing Studio database.

## Fixed pairing

The executable source of truth is [baseline.json](../../scripts/studio-preview/baseline.json).
It contains the full native wheel filenames, public URLs, sizes and SHA256s copied
without changes from ACP #6. Preparation checks that the accepted ACP manifest
and this native manifest agree.

| Component                            | Selected identity                                                          |
| ------------------------------------ | -------------------------------------------------------------------------- |
| Studio base                          | `c47a346db8d0303bc64a1a0bf93b4b94cceb99df`                                 |
| AionUi source ancestor               | `v2.2.2`, `6744099b279b991c17e31c243f0920477bd31cb6`                       |
| Native                               | Four public `0.1.0b2` wheels; no native patches                            |
| Native public source reference       | `v0.1.0-beta.2`, `1093cc2578e70500c91fe0a8d340b7db2528c8de`                |
| ACP installed wheel                  | `0.1.0`, built from `c573b2cacc26b1b76e1377ceeaa1bd1bf6b3431e`             |
| ACP source archive SHA256            | `dd7dc00f54b264c238d2468ebd5cba0a99424f99376622f38de2d41e27db66ff`         |
| AionCore                             | Public `v0.2.2`, release target `47e66d0d151123e973b3fd1e77afcb5671b3f8c5` |
| AionCore darwin-arm64 archive SHA256 | `70c50b84be9e17ba574a2c74370e6d57a267f44bdd6ecf641740cf220737d5cb`         |
| Extracted AionCore executable SHA256 | `04404864ca622159ffcc79ef9cb468e82fc820b91f16d565c5a5efdb0b0c4cb1`         |

The native tag is a public source reference; this does not independently attest
that the registry wheels were built from that tag. The AionCore release archive
digest is checked against its published GitHub release identity. The existing
Studio `package.json` AionCore pin must match the selected pairing. ACP's version
alone does not identify its source: the exact archive and installed package-file
hashes do. Building the ACP wheel again can change wheel container metadata;
each local wheel digest is recorded separately.

## Reproduce on macOS arm64

Use Node.js 22+, the repository's Bun dependencies, Python and `uv`. Network is
needed during preparation and public registry audits. From a clean Issue worktree:

```sh
python3 scripts/studio-preview/prepare.py
bun run package
.local/studio-preview/native/bin/python -B scripts/studio-preview/smoke.py
python3 -B -m unittest discover -s tests/studio-preview -v
```

Preparation refuses an existing `.local/studio-preview` directory. Preserve an
older run under another ignored path before preparing a fresh one. The venvs are
qualification environments with absolute entrypoint paths, not relocatable
installer payloads; do not execute an archived/moved venv. Preparation installs
native and ACP wheels in separate new venvs, hashes the downloaded source and
AionCore archives, and runs the unchanged ACP qualifier (native 6 / adapter 4).
Resolved Python/dependency versions are in `qualification.json`; transitive
dependencies and Python downloads are not a reproducible release lock.

`smoke.py` strips inherited provider credentials, Python paths and user config
roots through ACP's qualified isolation fixture. It uses temporary native
auth/settings/session roots and Electron userData. The existing custom-agent API
registers the installed ACP through a Node launcher that forwards argument arrays
without a shell. No production database, native wheel, ACP source or operator
profile is modified. Only synthetic prompts/responses are used.

The actual renderer's existing model menu, send button and Stop button drive the
checks. The Stop probe waits until the loopback provider holds an active request.
AionCore translates legacy ACP selectors to `mode` and `model` config options.
Selecting the launch model is a no-op; requesting another model must fail, and
the following provider request must still use `one`. Reasoning/context bindings
are not inferred from native symbols or from the existence of Studio UI.

## Evidence and boundaries

The local result is summarized in [acceptance.json](acceptance.json). Generated
details live under `.local/studio-preview/`: `receipt.json`, `qualification.json`,
`runtime-observed.json`, `host-smoke.json` and `studio-session.png`.
The final host receipt is passed only after actual UI checks, process cleanup,
provider observations and pre/post native/ACP member checks. A failed rerun writes
failed instead of retaining a previous success. Harness and built main/preload
hashes bind the receipt to the tested local bytes.

Native auditing compares 309 original members, including metadata, with the
public wheels. Installer-rewritten RECORD is excluded; this is not a transitive
dependency, bytecode or full environment security attestation. Installed ACP
package hashes must match both the accepted source and the preparation receipt.
Prepared launcher, entrypoint, qualification and AionCore drift is refused before
starting the host.

This qualification covers macOS arm64. Windows/Linux/other macOS architecture,
real-provider/OAuth, packaged app/installer lifecycle, mobile, authenticated WebUI,
offline installation, Analytics and actual Team turns were not accepted here.
The Preview product still requires its planned five build targets; limiting this
test harness does not remove those release requirements. Current ACP main is
POSIX-only, and packaging must not silently select this pin for Windows.

## Candidate decisions and next owner

| Existing candidate                                         | Decision for this baseline                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap `3a8763cfd56acd52024b4a0634acaca7cedb48e4`       | Adapt the argument-array Node launcher and existing custom-agent/assistant API pattern. Keep branding, automatic registration, Analytics caches, offline packaging and installer changes out of this qualification diff; their old CI is not evidence for this pairing.                                                                 |
| Existing dirty runtime-controls on that branch             | Preserve in its original checkout. Exclude wholesale import, private native source installation, compatibility patching and control-v1-dependent settings UI. Existing upstream model/send/Stop UI is sufficient for the baseline. Production reasoning/context/model switching needs subsequent ACP/host work.                         |
| ACP PR #1 `8deb482bcd53261762979cf0e6ce1302dcc821c1`       | Exclude from this baseline: public beta.2 default startup rejects the control-v1 requirement. Do not enable `--allow-legacy-runtime`. Reuse of extension/restore paths first requires [ACP #9](https://github.com/handochan/aelix-acp/issues/9) and [#10](https://github.com/handochan/aelix-acp/issues/10) fixes and fresh validation. |
| Upstream policy `36920e76467a4b8751e557b995fa2f63a7833f92` | Retain Apache-2.0 notices and the existing source history. Record the upstream ancestor and AionCore pairing here. Defer importing the policy workflow/manifests as a separate reviewed W10 adoption; it references the older bundle and cannot be copied unchanged.                                                                    |

The original `codex/studio-runtime-controls` checkout and other worktrees were
preserved. This Issue uses `codex/studio-4-beta2-baseline` in a separate managed
worktree. No reset, stash or wholesale merge is part of the integration.

[ACP #7](https://github.com/handochan/aelix-acp/issues/7) consumes the pairing and
actual host selector translation, then defines sessionless management versus live
session responsibilities, authorization/cancellation and unsupported responses.
Ask/Yolo, provider onboarding, richer selectors, sessions/resources/Team remain
their existing follow-up Issues. There is no new `/clear` implementation. The
known 16 MiB frame and aggregate-history limits remain. Studio #4 remains open
until review and authorized repository delivery are accepted; local host success
is not a merge, CI, installer or product-release claim.
