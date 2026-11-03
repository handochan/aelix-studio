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
