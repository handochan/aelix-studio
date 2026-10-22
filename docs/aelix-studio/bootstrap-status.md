# Bootstrap verification — 2026-10-23 (Asia/Seoul)

## Prepared

- GitHub fork: https://github.com/handochan/aelix-studio
- Local checkout: `/Users/handochan/dev/aelix-studio`
- Working branch: `chore/aelix-studio-bootstrap`
- Stable base: AionUi v2.2.2, `6744099b279b991c17e31c243f0920477bd31cb6`
- Remotes: origin is the fork; upstream tracks the original main and tags. Upstream push is disabled locally.
- Node 24.22.1 / Bun 1.4.4 installed only under `.local/toolchains` with official archive SHA-256 verification.
- Frozen-lockfile dependency installation completed: 1,593 packages. The tracked lockfile is unchanged.
- Official AionCore v0.2.2 and its managed resources prepared under `resources/bundled-aioncore/darwin-arm64`.

## Completed checks

| Check                                                                | Result                               |
| -------------------------------------------------------------------- | ------------------------------------ |
| Read-only latest stable release / commit comparison                  | current: v2.2.2 at the pinned commit |
| Node syntax and shell syntax checks                                  | passed                               |
| New release-tracking CLI tests + upstream build bootstrap tests      | 2 files, 14 tests passed             |
| TypeScript (`tsc --noEmit`)                                          | passed                               |
| Lint for the bootstrap change                                        | passed, no warnings/errors           |
| Electron main/preload/renderer production bundle (`bun run package`) | passed                               |
| `git diff --check`                                                   | passed                               |

The build emitted an upstream large-chunk warning; it completed successfully.
The dependency install reported an existing unused 7zip-bin patch warning; the
install completed and did not change bun.lock.

Logs: `.local/install.log`, `.local/prepare-backend.log`,
`.local/bootstrap-tests.log`, `.local/typecheck.log`, `.local/bootstrap-lint.log`,
`.local/build.log`, `.local/upstream-check.json`.

## Delivery boundary

These are local bootstrap changes. No downstream installer or signed release was
created. Branding, the default Aelix agent, Aelix/ACP runtime bundling, independent
update feeds and dedicated product data paths remain the next implementation work.
No Electron window, real provider call, Windows/Linux runtime, or installer was
validated in this bootstrap. The full upstream test suite and remote CI were not
run; the 14-test result above is the focused bootstrap baseline.

No application source or upstream LICENSE/NOTICE was modified. The installed
AionUi application and its production data were not changed.
