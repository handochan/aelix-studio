# Permission recovery host candidate (Studio #16)

This separately identified AionCore source build fixes the ordinary ACP
`session/load` path after a failed Yolo → Ask transition. The restored agent's
reported permission becomes the host's observed and desired state. Old mode
startup seeds, cached generic mode values and raw selections cannot replay Yolo
over the restored policy. Model/thought preferences and later explicit user
changes retain their existing behavior.

The upstream release path overwrites the returned mode with an older database
preference. Removing only that assignment is insufficient: reconciliation could
replay the old desired permission. The patch also emits the final observed
configuration event consumed by the existing SQLite persistence writer.

## Scope and identity

- [source.json](source.json) pins public AionCore `v0.2.2` commit
  `47e66d0d151123e973b3fd1e77afcb5671b3f8c5`, its exact archive, Cargo lock,
  toolchain, patch and three changed files.
- [permission-restore.patch](permission-restore.patch) contains the host change
  and six focused Rust regression tests. It does not modify public Aelix beta.2
  native wheels or install a private native core.
- [build.py](build.py) checks all 1,420 original source files before patching,
  verifies all patched originals before and after the locked build, and copies
  the binary and upstream `LICENSE` with a build receipt. It refuses existing
  output paths, unsafe archive members, unexpected bytes and another toolchain.
- Acceptance currently covers a **Darwin/arm64 dev build**. This is a local
  source-built candidate, not the released Studio #4 binary, installer or
  cross-platform acceptance. The released baseline manifest and default runtime
  selection remain at their existing pins. Candidate use is explicit through
  `AIONUI_BACKEND_BIN` after receipt verification.
- The upstream root `LICENSE` is preserved verbatim (Apache-2.0 text); its
  workspace Cargo metadata declares MIT. Both are recorded without replacing
  the original license or making a new licensing interpretation.
- This addresses the permission-recovery part of
  [Studio #16](https://github.com/handochan/aelix-studio/issues/16). It does not
  complete metadata/request-ID/custom-action forwarding or the independently
  owned [Studio #5](https://github.com/handochan/aelix-studio/issues/5).

## Reproduce

Use the upstream-pinned Rust 1.95.0, Python 3.11+, and Git. Toolchains and caches
can be task-local; no global installation is performed by these scripts.
Use separate Cargo target directories for separate extracted source trees.
If explicitly reusing `--target-dir`, serialize builds and complete test runs:
another build can replace metadata needed by a still-running doctest phase.

```sh
curl -fL https://api.github.com/repos/iOfficeAI/AionCore/tarball/47e66d0d151123e973b3fd1e77afcb5671b3f8c5 \
  -o /absolute/task/aioncore-source.tar.gz
python scripts/studio-preview/host-recovery/build.py \
  --archive /absolute/task/aioncore-source.tar.gz \
  --output /absolute/task/recovery-host

# In the prepared ACP #5 public-wheel qualification worktree:
.local/native/bin/python -B scripts/qualify_permissions.py \
  --adapter /absolute/acp/.local/adapter/bin/aelix-acp \
  --host /absolute/task/recovery-host/aioncore \
  --host-receipt /absolute/task/recovery-host/build-receipt.json \
  --host-source-manifest /absolute/studio/scripts/studio-preview/host-recovery/source.json \
  --report /absolute/task/recovery-wire.json

# Build this Studio worktree, then run its actual Electron renderer:
bun run package
/absolute/acp/.local/native/bin/python -B scripts/studio-preview/host-recovery/smoke.py \
  --acp-source /absolute/acp \
  --adapter /absolute/acp/.local/adapter/bin/aelix-acp \
  --artifacts /absolute/acp/.local/beta2-wheels \
  --host-receipt /absolute/task/recovery-host/build-receipt.json \
  --report /absolute/task/recovery-ui/qualification.json
```

The ACP worktree must include the receipt-aware qualifier introduced alongside
this change; the installed ACP production payload remains candidate `f5d1d5a`.
The UI smoke uses the existing selector and Reconnect control, with Korean and
English label matching. A raw out-of-band HTTP restart does not invoke the UI
owner's SWR revalidation; the smoke therefore exercises the actual UI action.
All effects use temporary roots and a synthetic loopback model. No real provider
credentials, raw transcripts or model diagnostics are published.

## Acceptance evidence

[qualification.json](qualification.json) binds the source, binary and complete
local receipts. Wire checks include a failed downgrade, actual tool consent
without a file effect, read-only observation of the corrected SQLite state,
full host process exit/reload, and a later explicit Yolo choice. UI checks include
the displayed restored mode, visible Allow/Reject buttons, cancellation without
a write, and a later Yolo selection with an actual file effect.

The unchanged released host remains a separately reproduced known failure.
Local candidate acceptance does not mark ACP #5 or Studio #16 Done: reviewed
host delivery/integration and the rest of #16 remain outstanding. Real-provider,
Windows/Linux host, installer and field acceptance remain unrun.
