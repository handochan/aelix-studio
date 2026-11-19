# Solo Aelix session lock release

[Studio #30](https://github.com/handochan/aelix-studio/issues/30) · [Host #51](https://github.com/handochan/aelix-studio-host/issues/51) · [ACP #34](https://github.com/handochan/aelix-acp/issues/34)

A Studio view renews its foreground lease with `POST /api/conversations/c1/active-lease`.
Each mount has a fresh UUID. The existing request without a body continues to renew a legacy lease.

```json
{"view_id":"a6407d4e-c752-4970-8bc2-3d1c9ee18876"}
```

On departure the view stops renewing and sends the same JSON body to
`POST /api/conversations/c1/runtime/release` using the normal authenticated host transport.
The host checks conversation ownership before changing its state. Responses use the existing API envelope.

```json
{"success":true,"data":{"outcome":"released"}}
```

`released` means the host finished the owned ACP process teardown. `inactive` covers an absent
runtime or another backend. `view_active` means another foreground view still covers the
conversation. `busy` means a turn or other runtime operation still has the runtime. On `busy`,
Studio retries while the view remains closed and stops retrying when it reopens. A reopened
view waits for any in-flight release from that renderer before ensuring its runtime.

Release is scoped to standalone Aelix ACP runtimes. The conversation row, history and saved ACP
session anchor survive. The host tears down the per-conversation ACP transport through its
existing process supervisor, and ACP closes its native worker through its existing EOF or
shutdown cleanup. This lifecycle operation needs no new ACP method or native change.

Normal desktop quit uses the existing host shutdown. If a release request is lost and the
host is still running, the existing standalone idle scanner remains the fallback after the
foreground lease expires. Its default idle threshold is 10 minutes with a one-minute scan
interval. Studio continues to hold the lock between turns while the view stays open.
