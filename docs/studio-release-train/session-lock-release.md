# Solo Aelix session lock release

[Studio #30](https://github.com/handochan/aelix-studio/issues/30) · [Host #51](https://github.com/handochan/aelix-studio-host/issues/51) · [ACP #34](https://github.com/handochan/aelix-acp/issues/34)

Each Studio mount uses a fresh UUID. It registers the view while warming the runtime with
`POST /api/conversations/c1/runtime/ensure?view_id=a6407d4e-c752-4970-8bc2-3d1c9ee18876`.
It then renews the registered view through `POST /api/conversations/c1/active-lease`.
The existing request without a body continues to renew a legacy lease.

```json
{ "view_id": "a6407d4e-c752-4970-8bc2-3d1c9ee18876" }
```

On departure the view stops renewing and sends the same JSON body to
`POST /api/conversations/c1/runtime/release` using the normal authenticated host transport.
The host checks conversation ownership before changing its state. Responses use the existing API envelope.

```json
{ "success": true, "data": { "outcome": "released" } }
```

`released` means ACP acknowledged close and the host retired the old runtime. `inactive` covers
an unknown, expired or already retired view, an absent runtime or another backend. `view_active`
means another foreground view still covers the conversation.

```json
{ "success": true, "data": { "outcome": "deferred" } }
```

`deferred` means the host accepted the departure and will close when the current operation ends,
even if the browser tab has closed. The host checks the exact runtime identity and current views
before passing close to ACP. A newly admitted view supersedes a pending departure. If close has
already started, ensure waits for it on the host and opens the saved session afterwards. A short
tombstone rejects late requests from the departed view. Unknown stand-alone heartbeat requests
cannot register a view. The renderer bounds the heartbeat and departure HTTP requests and starts
reopening independently of their responses.

Release is scoped to standalone Aelix ACP runtimes. The conversation row, history and saved ACP
session anchor survive. ACP `a78db597d` already closes non-destructively through
`_aelix/manage` with `sessions/close`. ACP advertises the same operation as `close: {}` in
`agentCapabilities.sessionCapabilities`, so the host can use its existing standard ACP client.

```json
{ "jsonrpc": "2.0", "id": 7, "method": "session/close", "params": { "sessionId": "acp-session-1" } }
```

```json
{ "jsonrpc": "2.0", "id": 7, "result": {} }
```

ACP acknowledges only after its native worker exits. The host then retires its cached
runtime so reopening loads the saved ACP session. If an ambiguous response arrives or the close
response is lost, the host retires the old connection before accepting a new ensure. An explicit
pre-dispatch protocol refusal leaves the runtime eligible for normal idle cleanup.

Normal desktop quit uses the existing host shutdown. If a release request is lost and the
host is still running, the existing standalone idle scanner remains the fallback after the
foreground lease expires. Its default idle threshold is 10 minutes with a one-minute scan
interval. Studio continues to hold the lock between turns while the view stays open.

Run the real tab-close regression with a built Studio source tree by passing `--studio-root`
to the host's `scripts/verification/smoke_session_release.py`. The fixture starts an active
native turn, opens and closes a Chromium tab, finishes the turn and checks that the CLI
immediately opens the same native session. Set `STUDIO_RELEASE_CHROMIUM` if using a system
Chromium executable.
