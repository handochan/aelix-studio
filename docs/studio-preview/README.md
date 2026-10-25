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
