# Studio #15 outbound behavior and validation

The branch merges Studio #35/main `4473720` without rewriting history and applies
[the remaining decisions](https://github.com/handochan/aelix-studio/issues/15#issuecomment-6616678246)
and [review/transport decisions](https://github.com/handochan/aelix-studio/issues/15#issuecomment-6618464352).
The [earlier snapshot](history-20019.md) retains historical source/counts; it is
not the current policy. The [IPv6 study](ipv6-investigation.md) remains research
evidence: 76 UDP connects, zero probe packets, 42 detected/received positive
control packets. No Electron upgrade or address exemption was applied.

## Current inventory

| #          | Feature                  | Implementation                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2        | Automatic/manual updates | Startup checks default on, exclusively Studio Releases. About settings saves `update.autoCheck`; false disables automatic checks. Blocked startup checks are quiet; manual About/tray checks retain errors. Local download metadata and sha512 restore cached updates without GitHub. Downloaded GitHub asset hosts are accepted only after a Studio release URL redirect. |
| 3          | Sentry                   | Main/preload/renderer initialization, device IDs, build plugin, release/source-map steps, secret injection and SDK/build dependencies removed.                                                                                                                                                                                                                             |
| 4–5        | Logs/feedback            | No scheduled upload. Explicit feedback/diagnostics saves local JSON/ZIP. All 13 locale descriptions reflect local saving.                                                                                                                                                                                                                                                  |
| 6–8,14     | Host defaults            | #35 supplies immutable host aelix.4 and its already accepted outbound/runtime policy. No host source changes or runtime overrides here. Explicit user endpoints, providers/OAuth, MCP, channels, speech and WebUI remain.                                                                                                                                                  |
| 9          | Monaco                   | Exact 0.55.1 direct dependency, lazy local ESM editor and five worker families; no CDN loader. Local failure has a translated explanation.                                                                                                                                                                                                                                 |
| 10         | Chat remote images       | Per-source explicit load action, propagation/default stopped inside links, dedicated translated host/connection explanation, visible retry, no srcset forwarding. Local/data/blob images remain.                                                                                                                                                                           |
| 11         | Preview fallback         | Main/#35's local failure behavior retained.                                                                                                                                                                                                                                                                                                                                |
| 12         | Bing                     | First non-URL search requires consent before navigation. Decline explains why nothing was sent. URL navigation, including IPv6 literals, remains. Approval persists locally; stale confirmation cannot navigate a later intent.                                                                                                                                            |
| 13         | Provider headers         | AionUi referral headers removed; user headers/endpoints preserved.                                                                                                                                                                                                                                                                                                         |
| 15         | Hub build input          | Existing `dist-latest` build preparation retained. Immutable Hub input pin/offline build import remains separate follow-up; no visible feature removed.                                                                                                                                                                                                                    |
| Additional | Browser MCP              | Exact 0.16.0 package plus already vendored dependencies copied unchanged/unpacked. Same Node binary executes an absolute local entry; no runtime npx download. Metrics opt-out remains. Exact legacy Studio-owned standalone rows migrate without changing enablement; customized user commands stay configured.                                                           |

[Offline resource manifest, licenses and reproduction](../../scripts/outbound-audit/bundles/README.md)
cover the complete official dictionary bundle and browser MCP. All 55 versioned
dictionary files/47 variants (including retained old/pseudo dictionaries) ship,
plus 47 per-language/source notices and original license files. The dictionary
archive is 34,406,377 bytes / 112,260,879 bytes unpacked; installer deltas must be
measured on the actual resulting artifacts. macOS uses its native spellchecker.

## One blocking audit policy

The app compatibility CLI directly imports main's `outboundAudit.py`; the old
`destinationPolicy.py` snapshot is deleted. The app job selects no executable
roots and enforces the entire tree through final descendant exit. Host/native
jobs retain executable-root scope and their separate diagnostic whole report.
Both use the same parser, lineage, FD lifecycle, destination policy, io_uring
recorder/allowlist and incomplete-evidence rules.

TCP connect and UDP send/write attempts remain counted even on failure. A UDP
connect is separately counted as `udpConnectOnly` only after a proven closed,
unsent lifecycle across fork/CLONE_FILES, dup/fcntl, close_range and exec. Open-at-
exit/missing closes, undecodable addresses/results and unknown UDP imports fail.
Kernel tracepoints do not expose io_uring's target FD: a write submission in a
process holding such an association fails when nonoverlap/unrelated FD cannot be
proved. This is deliberately conservative across uncertain timing, never an
address/name exception. Missing capture, lost events, attribution or incomplete
trace evidence also fails. No syscall-only fallback or report-only app gate.

The new real route-free Linux controls require:

| Control                                               | Expected result                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| UDP connect then close                                | exit 0; external/unparsed/classification 0/0/0; separate association 1 |
| UDP connect then send                                 | exit 86; external 2, no unparsed/classification                        |
| UDP connect then inherited/duplicate send             | exit 86; external 2, no unparsed/classification                        |
| UDP connect then io_uring WRITEV with unobservable fd | exit 87; classification failure, no proven association exemption       |

Existing direct/child/host controls remain exit 86; normal and SQPOLL io_uring
CONNECT remain exit 87 with precisely one forbidden opcode. Positive controls
are required, never filtered from functional results.

## Validation boundary

`studio-outbound.yml` runs on draft PRs. It builds/installs both Linux targets and
requires whole-tree external/unparsed/classification 0/0/0 during synthetic
sessions, permission changes, restart and separate 35-second startup observation.
It seeds the exact persisted user setting to disable automatic update checks,
without an environment guard or endpoint exception. Separate tests require the
default-on request to Studio Releases and quiet blocked-network behavior, bundled
MCP startup/tools-list, and a real local Monaco editor/HTML worker.

Local source/engine fixtures are distinct from installed app acceptance and exact-
head CI. No real provider credentials are used. macOS Monaco fixture evidence
is renderer-request/worker evidence, not a syscall-level audit; Windows local
diagnostic export likewise does not establish whole-app outbound zero. Internal
endpoint/CA/proxy UI, extension/Analytics offline import and complete five-target
closed-network customer installation remain broader follow-up obligations.

Current-head counts, controls, installer sizes and CI receipts are recorded in
Issue #15/PR #36 after exact-head verification. Green unit tests alone do not
establish G12. No release/feed publication, merge, tag or main push is performed.
