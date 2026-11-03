# Synthetic model and permission fixtures

These test-only fixtures are derived from `handochan/aelix-acp` commit
`117cf6c9d536c4aa98b1f3a6481c12464584960c` (`scripts/beta2_wire.py`,
`qualify_permissions.py`, `permission_fixture_extension.py`), under Apache-2.0.
Copyright Aelix Contributors; the repository LICENSE applies. They now live in
Studio because ACP #20 retired its public-beta.2 qualification harness.

Only the synthetic HTTP model, owned environment setup and permission-effect
extension are retained. They do not provide native compatibility or production
execution behavior. Credentials are synthetic, state is temporary, and the model
listens on loopback. Installed source-wheel integrity is checked separately by
`../packaging/runtime.py`; fixture reuse is not public-wheel acceptance.

`outboundAudit.py` is copied byte-for-byte from the host release source
`72e0e92008067531cf3aa673a6b62f16a87cc6fa`,
`scripts/release/outbound_audit.py` (Apache-2.0). SHA-256: `80d15a8056a498b4f2d8555ae97a53c800881b8a0903c4a75c4b3af1895b8caa`.
Linux CI traces the actual installed Studio app, pinned released host and native/ACP
process tree during the permission smoke with a loopback model.
Failed TCP/UDP attempts in both parent and child controls must be detected.
Only loopback/Unix IPC is allowed; DNS attempts and incomplete traces fail.
This is evidence for the exercised default fixture, not arbitrary providers,
installed extensions, proxies or all platforms. Raw traces suppress buffers and
are discarded; JSON counts are retained.
