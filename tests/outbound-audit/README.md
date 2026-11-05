# Audit regression tests

Run `python -B -m unittest discover -s tests/outbound-audit`. Synthetic strace
records cover descendant attribution, failed IPv4/IPv6/DNS attempts, interleaved
calls, termination and incomplete evidence. CI separately runs a real OS-level
TCP/UDP positive control and the actual installed app. Parser fixtures alone do
not establish zero outbound attempts.
