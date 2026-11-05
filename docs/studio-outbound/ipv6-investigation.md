# IPv6 reachability probe investigation — 2026-11-04

The probe is a local UDP routing/source-address test. In the qualified Linux
experiments it issued `connect` calls but sent **no packets** to or from the probe
address. No tested public control removed those calls. The production audit
still rejects them; this investigation changes no audit exception, enforcement,
production application setting, Electron dependency, shared manifest, or packaging recipe.

This follows the [user decision](https://github.com/handochan/aelix-studio/issues/15#issuecomment-6616678246).
Dictionary/browser-MCP bundling, Bing first-use consent and Monaco implementation
remain queued after #35. They are not implemented by this follow-up.

## Source path

Current binary: Electron **37.10.3**, Chromium **138.0.7204.251**, Linux arm64.

1. [`RequestImpl::Start` / `DoIPv6Reachability`](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager_request_impl.cc)
   enters the IPv6 check before local/IP-literal resolution. IPv4 loopback HTTP
   requests therefore also trigger it. The
   [service-endpoint resolver](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager_service_endpoint_request_impl.cc)
   used by Happy Eyeballs has the same initial check.
2. [`HostResolverManager::StartIPv6ReachabilityCheck`](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager.cc#1479)
   joins an in-flight check or reuses its result. A first check, a result older
   than **1,000 ms**, or an IP-address change requires a new check. There is also
   a WiFi-specific skip when the embedder disables checking IPv6 on WiFi; this is
   an embedder condition, not a general Electron probe-off API; its negative result can restrict AAAA unless separately overridden.
3. [`StartGloballyReachableCheck` / `FinishGloballyReachableCheck`](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager.cc#1527)
   creates a datagram socket, calls `ConnectAsync` on
   `[2001:4860:4860::8888]:443`, and reads the selected local address. Link-local
   and Teredo source addresses are rejected. This path has no send/receive call.
   Port 443 here is **UDP**, not a TCP/TLS handshake.

This matches Linux [`connect(2)` semantics](https://man7.org/linux/man-pages/man2/connect.2.html):
for a datagram socket it sets the default peer association. It does not establish
a TCP connection. A successful local route lookup does not prove a reply from
Google or public-Internet reachability.

## Public controls and supported newer versions

The [37.10.3 public API](https://github.com/electron/electron/blob/v37.10.3/docs/api/app.md#appconfigurehostresolveroptions)
and [binding](https://github.com/electron/electron/blob/v37.10.3/shell/browser/api/electron_api_app.cc)
expose built-in DNS selection, Happy Eyeballs, DoH settings and additional DNS
query types. None is a probe-off option. The 45.2.2 binding exposes the same five
keys. All calls in the experiment occur after `ready`.

| Current-engine control                                                                   | Probe connects, no Google route / routed lab | Probe packets |
| ---------------------------------------------------------------------------------------- | -------------------------------------------- | ------------- |
| Default                                                                                  | 3 / 3                                        | 0 / 0         |
| Existing Studio background/component/domain-reliability switches + OS resolver / DoH off | 3 / 3                                        | 0 / 0         |
| Built-in resolver on, DoH off                                                            | 3 / 3                                        | 0 / 0         |
| `enableHappyEyeballs: true`                                                              | 3 / 3                                        | 0 / 0         |
| `enableAdditionalDnsQueryTypes: false`                                                   | 3 / 3                                        | 0 / 0         |
| `EnableIPv6ReachabilityOverride` feature                                                 | 3 / 3                                        | 0 / 0         |
| `HappyEyeballsV3` feature                                                                | 3 / 3                                        | 0 / 0         |
| Documented `host-resolver-rules` mapping of the fixture hostname to its IPv6 address     | 3 / 3                                        | 0 / 0         |

The multi-request cases load IPv4, IPv6 literal and IPv6 hostname fixtures, with
1.2 seconds between loads to exercise the one-second cache. The public
[host-resolver switch](https://github.com/electron/electron/blob/v37.10.3/docs/api/command-line-switches.md#--host-resolver-rulesrules)
does not affect the fixed IP used inside the UDP check. Chromium feature flags
are source-backed experimental controls, not a documented Electron probe-off
contract. The override is recognized: it retains AAAA results after a negative
probe, but [its use in query-family selection](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager.cc#792)
does not bypass the check. The alternative-port feature only changes its port.

No global IPv6-disable method or Google-address audit exclusion was used.
Configured IPv6-literal HTTP endpoints succeeded in every multi-request case.
IPv6-hostname endpoints succeeded with the lab route. With only private IPv6
connectivity and no Google route, some resolver configurations suppressed the
AAAA-only hostname; the override restored it while still making the probe.
A future engine change must preserve IPv6 resolution and endpoint access.

Electron supports its [latest three stable majors](https://www.electronjs.org/docs/latest/tutorial/electron-timelines).
The [official release index](https://releases.electronjs.org/releases.json) at
inspection time listed:

| Electron | Chromium       | Verification                                               |
| -------- | -------------- | ---------------------------------------------------------- |
| 43.8.7   | 150.0.7871.250 | Source inspection                                          |
| 44.10.2  | 152.0.7977.169 | Source inspection                                          |
| 45.2.2   | 156.0.8078.80  | Source inspection and separate official Linux arm64 binary |

The [150](https://chromium.googlesource.com/chromium/src/+/150.0.7871.250/net/dns/host_resolver_manager.cc),
[152](https://chromium.googlesource.com/chromium/src/+/152.0.7977.169/net/dns/host_resolver_manager.cc), and
[156](https://chromium.googlesource.com/chromium/src/+/156.0.8078.80/net/dns/host_resolver_manager.cc)
default-network paths still contain this UDP check. Newer code can skip a check
for explicitly bound non-default network handles (Cronet/CCT-related work);
that is not exposed by Electron's host-resolver API and did not change the
measured desktop default path. Electron 45.2.2 default, current-policy, override
and Happy Eyeballs API cases each retained **3 connects / 0 probe packets** in
both route conditions. Upgrading alone is not a demonstrated remedy.

The [candidate ZIP](https://github.com/electron/electron/releases/tag/v45.2.2) was verified against official
[SHASUMS256.txt](https://github.com/electron/electron/releases/download/v45.2.2/SHASUMS256.txt) and the GitHub asset digest: `ebecf43f3c348fd589bf3bfa5643842deb0993da94ce5604255799ac9d4512d1`.
It was unpacked only under `.local/`; no project version or lockfile changed.
Studio/native-addon/installer compatibility with 45 is not claimed.

## Packet capture

A disposable Docker `--network none` namespace contained only loopback and an
owned non-loopback veth pair. A separate peer namespace provided an IPv6 HTTP
fixture and UDP capture controls. The Google probe address was assigned only to
that isolated peer as a sink; it was not assigned or remapped in the application
or audit. The lab has no ISP-facing IPv6 connection; this measures a controlled non-loopback route, not public-Internet reachability.

- **Absent:** no route to the Google probe address. IPv6 remained enabled and
  the private IPv6 peer route was usable.
- **Present:** a `/128` route to the probe address via the veth peer, with a
  documentation-prefix source address selected by the kernel.
- `tcpdump --immediate-mode -U -s 54` captured all IPv6 frames on the veth.
  Ethernet and IPv6 headers were retained; transport payloads were not recorded.
  Capture counts had to match filtered packet counts with zero kernel drops.
- `strace -f -Y -yy` identified the probe descriptor as `UDPv6`, its connect
  result and the subsequent local-address query. Interleaved syscall records
  were joined before counting.
- Every case included a separate real UDP-send positive control to the IPv6
  peer. Routed cases also sent one control datagram to the exact probe address.
  Those packets reached the isolated sink and were captured.

The probe-only cases use one IPv4 loopback HTTP load and remove the next-hop
neighbor-cache entry before starting. Thus a warm neighbor cache cannot hide
neighbor-discovery traffic caused by the check.

| Engine / condition       | Probe `connect` | Result        | Probe send syscall | Probe-phase IPv6 wire frames | Separate UDP control                    |
| ------------------------ | --------------: | ------------- | -----------------: | ---------------------------: | --------------------------------------- |
| 37.10.3, no Google route |               1 | `ENETUNREACH` |                  0 |                            0 | peer: 1 captured                        |
| 37.10.3, routed lab      |               1 | success       |                  0 |                            0 | peer: 1, probe-address sink: 1 captured |
| 45.2.2, no Google route  |               1 | `ENETUNREACH` |                  0 |                            0 | peer: 1 captured                        |
| 45.2.2, routed lab       |               1 | success       |                  0 |                            0 | peer: 1, probe-address sink: 1 captured |

Across **28** qualified cases: **76** probe connects, **0** probe send calls,
**0** packets to/from the probe address, **42** captured positive-control UDP
packets, **0** kernel drops. The multi-endpoint cases also captured expected TCP
traffic to the configured private IPv6 fixture; their entire-interface packet
count is therefore not zero. The probe-only capture is zero for the whole veth,
including ICMPv6. Positive controls with a cold neighbor cache captured ICMPv6 as
well as UDP in the separate control phase.

The existing production auditor was also run unchanged against the current
engine's probe-only fixture. In both route conditions it recorded **one external attempt, zero unparsed,
command exit 0**, and returned **86**. Both packet captures were zero. Neither result was waived or converted to report-only.

[Machine-readable results and source/binary hashes](ipv6Measurements.json) retain
the exact experimental results. Raw header-only pcaps, traces and synthetic
NetLogs are under `.local/studio-15/ipv6/public-final/run/`, not committed binaries.

## Decision to return to the user

There is no demonstrated supported probe-off control in the inspected versions.
No production change is proposed from an ineffective flag.

1. **Recommended under the current rule:** keep syscall-attempt zero as the
   requirement and keep the gate failing. Request/design an upstream opt-out or
   a small maintained Chromium/Electron change that avoids the fixed-address
   probe while preserving IPv6/AAAA handling and real endpoint connectivity.
   Evaluate maintenance and five-target qualification before implementing it.
2. If the intended requirement is instead zero actual egress, explicitly decide
   whether to define a transport-aware metric: retain UDP `connect` associations
   in evidence, and enforce real UDP sends and TCP attempts. This is a policy
   change, not a Google-address exception, and has **not** been implemented.

A standard-version upgrade alone did not remove the call. The packet result does
not grant permission to weaken the current audit or declare G12 complete.
