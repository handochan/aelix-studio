# Permission recovery host (Studio #22 and #16)

The default bootstrap and packaging policy is [default.json](default.json).
It uses the same reviewed patch as the historical Darwin dev candidate, with
Rust 1.95.0 `release` builds for `darwin-arm64`, `darwin-x64`, `linux-arm64`,
`linux-x64`, and `win32-x64`. Darwin/Windows use native compiler toolchains; Linux
uses a matching-CPU Debian 11 compiler container pinned by OCI digests and recipe
hash. Public beta.2 wheels remain unchanged.

Run `bun run prepare:host` before the normal desktop/WebUI development launch.
Normal `dist` builds and Preview `prepare.py` call the same source preparation
path. Rust, Git, Python and the native compiler prerequisites are build-time
requirements; Linux host builds also require Docker. Installed Preview users
need none of those developer tools.
The cache lives under `.local/default-host/`. Existing incomplete or stale owned
build/bundle directories are refused; archive them before rebuilding. A failure
never selects an older release or a system PATH host. An explicit
`AIONUI_BACKEND_BIN` remains an operator/developer override, outside default
installer acceptance.

Build receipts bind the upstream archive, three patched files, all 1,420 source
members, Rust toolchain, build/identity recipes, Cargo lock, verbatim license and
binary code identity and the exported managed-resource inventory. Desktop/WebUI
launch verifies that identity and the whole
managed-resource inventory before spawning. Mach-O identity normalizes only
bounded terminal signing metadata. Receipts detect delivery drift; they are not
a substitute for installer signing or a trusted build pipeline. The native CI
images are macOS 15, Ubuntu 24.04 and Windows Server 2022. These results do not
establish the inherited upstream README's minimum OS versions. The compiler
container retains the upstream release GLIBC requirement ceilings (x64 2.34,
ARM64 2.30); each built ELF is checked with `readelf` before its receipt is
accepted. Windows explicitly fixes `-C target-feature=+crt-static`. Receipts bind
the compiler container identity, measured GLIBC maximum and target Rust flags.
PE runtime import auditing and actual minimum/clean OS execution remain release
gates. Controller OS, compiler-container OS and installer-test OS are distinct
evidence; a static ABI check alone does not establish execution on that OS.

The Provider Preview installer additionally includes the relocatable public-wheel
native/ACP payload. Ordinary `dist` includes the default Rust host but does not
by itself establish acceptance of that additional Preview payload. The existing
five-runner Preview job installs actual DMG/DEB/NSIS artifacts, checks original
native members and Provider behavior, then runs `smoke.py --runtime ... --payload
...` against the installed app without backend/runtime overrides. Permission
checks include Ask deny/allow, Yolo effects, guard and other-extension denial,
observed native cancellation, failed downgrade, read-only saved-state observation,
full app/backend exit/relaunch, displayed/effective Ask and preserved history,
and a later explicit Yolo selection. The fault-injection custom agent uses an owned
whitespace-free directory alias to the installed Python because the upstream
custom-agent probe tokenizes its command field on spaces. The alias resolves to
the original installed executable; it substitutes no developer runtime. Reports remain separate from real-provider,
OAuth, field and final signed-release acceptance.

`source.json` and `qualification.json` below are the immutable historical
Darwin/arm64 dev-candidate identity and evidence. New default acceptance is
recorded by the Issue #22 PR, exact source SHA and CI artifact receipts.

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
- Historical candidate acceptance covers a **Darwin/arm64 dev build**. This is a local
  source-built candidate, not the released Studio #4 binary, installer or
  cross-platform acceptance. That historical candidate kept the released baseline
  and default runtime unchanged. Candidate use is explicit through
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
Historical candidate acceptance did not mark ACP #5 or Studio #16 Done.
Default-host acceptance is tracked separately in Issue #22; the remaining
Studio #16 forwarding and ACP #12 ledger contracts retain their own acceptance.
