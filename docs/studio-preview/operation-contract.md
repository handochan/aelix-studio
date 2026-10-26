# Managed prompt operation candidate

Status: Studio integration candidate for [ACP #12](https://github.com/handochan/aelix-acp/issues/12)
and [Studio #16](https://github.com/handochan/aelix-studio/issues/16). ACP PRs
[#17](https://github.com/handochan/aelix-acp/pull/17) and
[#18](https://github.com/handochan/aelix-acp/pull/18) provide the negotiated
adapter contract. [#19](https://github.com/handochan/aelix-acp/pull/19) retains
fixed provider-error diagnostics without raw error text. Studio pins its reviewed
head `117cf6c9d536c4aa98b1f3a6481c12464584960c`, merged in ACP main
`569737168199c4be65eeee803851fcc961d52a74`. Public native beta.2 wheels,
native auth/configuration/history semantics, and the existing host supervisor
remain the baseline. The broader [session/management proposal](../studio-release-train/session-and-management-contracts.md)
remains Proposed outside explicitly qualified additions.

## Negotiation and identity

The additive schema is `aelix.operation/1`, separate from any older
`runtimeControlVersion`. The agent must advertise the exact schema, operation
store identity, and the concrete `_aelix/operation_status` method before the host
uses it. An unkeyed legacy client retains its explicit lack of deduplication.
Unsupported/malformed keyed metadata is an error rather than an unkeyed retry.

The prompt's `_meta["aelix/operation"]` has exactly these fields:

```json
{
  "schema": "aelix.operation/1",
  "id": "stable-client-operation-id",
  "storeId": "negotiated-adapter-store-id",
  "conversationId": "host-owned-conversation-id",
  "turnId": "server-assigned-turn-id",
  "generation": "opaque-host-runtime-generation"
}
```

Identifiers are bounded ASCII tokens of 1–128 characters. The host supplies
conversation ownership and execution fences, and keeps its server-assigned
`msg_id`; a client operation ID never becomes that message ID. The client
persists one operation ID before first submission, including initial-message
and background-queue paths. Reconnect/retry must not invent another ID for
uncertain work. New/load/mode acknowledgements must refresh a verified native
generation; a timed-out acknowledgement invalidates the cached scope. The
host has a separate physical SQLite store identity, persisted before first
renderer submission and checked before every original-operation lookup.

The first admission freezes the accepted message/attachment/session-reference
and skill transformation, original turn/generation, adapter store and ACP
session binding. Duplicate admission precedes busy checks, turn claims, message
insertion, and HTTP acknowledgement. It returns the original message/turn IDs.
Transport or generation changes do not create a new semantic operation.

## Adapter ledger and ownership

The adapter commits its claim before writing the native prompt. One SQLite
transaction stores the operation namespace and random HMAC key; fingerprints
use only the accepted prompt and stable owner/session scope. Raw prompt,
arbitrary metadata, provider credentials, model/tool output, and exception text
are not ledger fields. Native's ordinary transcript semantics are unchanged.
Records have bounded identifiers and allowlisted outcomes, with no automatic
pruning, namespace reset, or startup sweep across other active sessions.

| Existing record                         | Result                                       | Native dispatch |
| --------------------------------------- | -------------------------------------------- | --------------- |
| Same ID, different accepted body/scope  | Structured conflict                          | Never           |
| Pending                                 | Pending or recovery waiting; effects unknown | Never           |
| Committed terminal                      | Original bounded terminal and replay marker  | Never           |
| Abandoned claim after actual owner exit | Interrupted; effects unknown                 | Never           |

Commit the allowlisted terminal before stdout publication. A failed publication
or late cleanup must not overwrite a committed terminal. Native end,
cancellation acknowledgement, and external-effect uncertainty are distinct.
Cancellation/EOF/timeout is not evidence that external effects did not happen.

Cooperating managed ACP sessions use a private OS lease inherited by the actual
native interpreter. A parent PID, parent-only lock, or a closed Job handle is
not proof of writer exit. POSIX cleanup closes its reference without `LOCK_UN`.
Windows keeps the Job handle noninherited and explicitly propagates a separate
nonshare lease handle ACP → pre-native Job gate → native. The `-I -S` gate loads
only its trusted adjacent helper, without depending on `PYTHONPATH`.

Immutable binding must converge on the original lease file and verify physical
state-root and lease identity. Namespace UUID alone cannot authorize a copied
state directory. Never unlink/recreate/truncate a lease to take ownership.
Recovery opens a fresh nonblocking lease; a still-held child reference means
recovery waiting, not a settled terminal. New native identities remain private
until binding completes before session registration/response. Existing binding
failures do not enable arbitrary path/import/discovery adoption.

This private protocol does not give the unmodified public CLI a common native
writer lock, promise safe legacy concurrent mutation, or provide exactly-once
external effects. Process-kill tests do not establish power-loss or arbitrary
backup/rollback safety.

## Existing host, status, and reverse requests

Use the authenticated existing facade and AionCore route. Validate login,
Origin, conversation ownership, schema/scope, frame/payload bounds, and deadlines.
Only the advertised concrete operation-status method is added; there is no
generic `_aelix/manage` proxy or helper control over a live native worker.
Status and completed-duplicate lookup must not start/load a native worker.
Status uses the original operation's store/session binding, not a newer resume
anchor. A changed or missing store is explicit uncertainty, never a fresh key.
The normal packaged `node` launcher resolves only the already activated pinned
cache executable for status. It never installs, executes a version probe, or
searches PATH. Its canonical path is part of the keyed command binding and must
match the actual manager launch; missing or changed paths retain uncertainty.

Account adoption preserves the physical store epoch, HMAC key, original message
and execution fences. The new owner can inspect an existing record, including a
cached terminal. Its request and launch fingerprints remain bound to the original
owner: resubmission conflicts, and pending recovery after restart cannot launch a
status-only process under the new owner. It remains unavailable/uncertain. Adoption
never resets the namespace, rekeys the operation, or dispatches it again.

Fence both existing recovery paths: `TurnOrchestrator.AutoReplayOnce` and the
ACP session-not-found fallback that clears a resume anchor and opens a new
session. Missing output does not prove that an operation had no effect.
Never move uncertain work to a different ACP session to bypass its ledger.

Reverse client actions use a bounded structured unsupported response. The pinned
SDK's request handlers share one
event loop (verified: `agent-client-protocol-2.0.0/src/jsonrpc.rs:784-845` and
`src/jsonrpc/incoming_actor.rs:595-634`; schema pinned to `1.5.0` by that SDK's
`Cargo.toml`). Permission/terminal waits must not prevent another request from
receiving a reply. Use connection-owned bounded tasks, preserve typed-handler
priority, and suppress SDK payload/error logs at every level, including WARN
parse errors and explicit development overrides. Core emits its own sanitized
lifecycle diagnostics. Keep a late
outgoing response's receiver alive rather than tearing down the connection when
a status deadline expires.

Existing host lifecycle logs remain useful. New admission/terminal boundaries
may add low-volume structured state and bounded opaque correlation IDs; polling
does not add a log per lookup. Payloads, credentials, raw metadata/errors, and
the ledger HMAC key never enter those logs. Ledger receipts and explicit fixed
errors are the primary operation diagnostics.

## Verification and acceptance

The source-built release host has local actual HTTP/stdio and Electron
qualification with synthetic model responses. The committed
[qualification drivers](../../scripts/studio-preview/host-forwarding/README.md)
repeat these checks inside each actual installer acceptance job. Reports keep
source, installed native, host wire, renderer and installer evidence separate.
The original native wheel members and installed adapter are audited before
and after. Cross-platform installation and final exact-head/main CI must be
completed before the integration Issue is Done.

Source tests are not installed/native acceptance. Verify actual public-wheel
native effects and installed ACP duplicate/conflict/concurrency, OS-process
interruption and child ownership, EOF, pending consent cancellation, and the
terminal-commit/publication gap. Then verify real host HTTP/stdio and existing UI,
including initial/queued/reconnected requests and no replay under uncertainty.
Finally qualify all five actual DMG/DEB/NSIS targets with unchanged native members,
independent review, exact-head CI, and actual merged-main verification. Keep
real-provider/OAuth/field and complete Preview release gates separate.
