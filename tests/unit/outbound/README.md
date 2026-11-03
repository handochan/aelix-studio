# Renderer outbound policy

DOM tests guard remote chat-image consent, source replacement, visible load
failure and explicit retry. They do not measure operating-system connections;
`scripts/outbound-audit/` and the installed-app CI job provide that separate check.
