# Immutable Studio host release

`default.json` pins `host-v0.2.2-aelix.2`, its source commit/tree, five archive
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
internal test database reset and next `aelix.3` scope.

The stdout markers, log/data/DB names, bootstrap secret and `AIONUI_*` interfaces
remain unchanged. Only the executable and release-archive identity have changed.
