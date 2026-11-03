# Immutable Studio host release

`default.json` pins `host-v0.2.2-aelix.4`, its source commit/tree, five archive
SHA-256 values and release provenance. `provenance.json` is the byte-preserved
published release asset. The release also publishes `aelix-studio-host-checksums.txt`;
its archive digests are pinned in `default.json`. The source archive/build/patch flow is retired.

`prepare.cjs` verifies each archive before extraction, checks the released binary,
retains LICENSE/NOTICE and the original build receipt, then asks the released host
to prepare managed Node resources at build time. Studio records a complete resource
inventory. Launchers verify release provenance, target, receipt, code identity,
license/notice and the managed-resource contract. The Linux receipt uses `GLIBC_2.30`;
Mach-O identity normalizes bounded installer signing metadata while retaining code.
The host identity recipe hash is recorded by the host, not compared against a
Studio script whose docstring differs.

`smoke.py` / `smoke.mjs` exercise the actual installed app and released host with
synthetic native model/tool effects: Ask deny/allow, Yolo and guardrail enforcement,
Stop, a Yolo→Ask failure under the `fail-start` marker, and full app/host
restarts in both modes. A transparent native stdio relay closes the real
`permissions/set` downgrade after ACP saves Ask and before native receives it;
it also rejects worker startup while the marker is present. No policy replies
are synthesized. After clearing the fault and fully restarting, the installed
host must restore Ask, require actual consent, persist the corrected selection,
and continue to permit a later explicit Yolo selection.
No Studio permission-restore patch or backend override is used. The old forwarding
harness and migration 044 are removed; see `docs/studio-preview/README.md` for the
internal test database reset and phase-two acceptance scope.

The stdout markers, log/data/DB names, bootstrap secret and `AIONUI_*` interfaces
remain unchanged. Only the executable and release-archive identity have changed.

## Updating the release pin

With dependencies installed and an authenticated `gh`, run:

```sh
node scripts/studio-preview/host-release/pin.cjs host-v0.2.2-aelix.4
```

The generator requires an exact published immutable stable release, verifies asset
API digests against the checksum file, checks provenance against the tag's commit
and tree, and requires all five target smokes. It generates `default.json`, the
byte-preserved `provenance.json`, `baseline.json` (including the SHA-256 of the
formatted source manifest), and `package.json`'s `aioncoreVersion`. It computes all
outputs before replacing files. Normal runtime preparation still verifies archive,
binary and receipt bytes. A pin change requires fresh resource/runtime preparation,
installer builds, and all acceptance tests; old `.local` outputs must not be reused.

Phase two initially tested aelix.3 and now pins the final aelix.4 release from
host #7 / PR #19. Native and ACP exact pins are unchanged. Every pin change is
qualified with fresh owned outputs; previous runtime/payload/resources are archived.
The Linux acceptance gate is zero external attempts and zero unparsed records
inside the host and installed-native descendant trees, with detected direct/child
positive controls. The whole app is reported separately for Studio #15; Chromium
policy is unchanged. See the [audit contract](../fixtures/README.md).

## Host environment

Settings come from the build operator's / launching process's environment, with
no Studio preference or implicit runtime opt-in:

- Build: set `AELIX_STUDIO_HOST_NODE_MIRROR` explicitly (CI uses
  `https://nodejs.org/dist/`). The released host verifies its pinned Node archive
  hashes. Missing settings do not enable a public fallback.
- Runtime: the shared desktop/WebUI launcher forwards
  `AELIX_STUDIO_HOST_NPM_REGISTRY` and `AELIX_STUDIO_HOST_REMOTE_IMAGES` unchanged.
  Omit both to retain host defaults. A registry is an HTTP(S) mirror URL; exactly
  `REMOTE_IMAGES=1` opts into the existing host image validation. Restart after
  changing launch settings. These environment settings are not renderer settings.
- User-installed npm/npx agents/MCP remain explicit user configuration; a mirror
  does not sandbox arbitrary extension code.

Remote preview images never fall back to a direct renderer request. Disabled
images and other failures have distinct localized explanations. ACP application
errors preserve `protocol_code` and opaque camelCase `data`; the four new error
codes provide guidance without replay/reconnect actions. MCP warning reasons and
`supersedes_key` survive both live display and history reload.

The default Hub preparation paths (`dist-latest`, and the packaging workflow's
`dist-ebc6a2b`) were inspected on 2026-11-03: their seven/four ZIPs contain no npx
agent launch or npx installation command. Several contain bunx launch recipes and
Bun install hooks; these are cached installation candidates, not preinstalled
extension agents. No extension is installed by this change. The source examples
and test fixtures are not bundled extension installs. This check does not promise
that a future mutable Hub index is unchanged.
