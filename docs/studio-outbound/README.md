# Studio #15 outbound defaults and remaining acceptance

This draft starts at main `dac2408`. It does **not** establish G12, offline
installation, or zero external attempts. PR #35 owns the host upgrade and its
preview-image fallback. Its shared files are held for integration after that PR
merges. This inventory distinguishes source changes, measured behavior and
remaining decisions; the Issue stays open.

## Inventory against main

| #        | Main behavior at `dac2408`                                     | This draft / remaining work                                                                                                                                                                                                                                                                                  |
| -------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | Startup checks `static.aionui.com`                             | Checks are off by default. Explicit `AELIX_STUDIO_AUTO_UPDATE=1` opts in to Studio Releases; the legacy disable, E2E and CI guards still win. Manual About checks remain available. Automatic cache restoration uses the same opt-in and checks local download metadata before contacting a release service. |
| 2        | Manual check and updater use AionUi/CDN                        | Both use `handochan/aelix-studio`. CDN rewriting and upstream download URLs are rejected. Release notes and installers come from Studio. No feed is published by this work (D13). Real upgrade/rollback and macOS download-only UI acceptance remain open.                                                   |
| 3        | Sentry initializes in main/preload/renderer; creates device ID | All runtime imports, initialization and ID generation are removed. The Vite plugin/DSN/source-map upload wiring is removed. `package.json` and dependency pruning remain held because #35 edits that file. Dormant SDK dependencies remain in the lockfile.                                                  |
| 4        | Scheduled startup log upload                                   | Scheduler and automatic reporting are removed. Local startup diagnostics remain.                                                                                                                                                                                                                             |
| 5        | Feedback and installation diagnostics send to Sentry           | Explicit report action downloads one local JSON bundle with base64 attachments and collection status. It does not silently add account email. Existing keys in all 13 locales describe local export. Windows installer failure diagnostics produce a local ZIP and never receive a DSN.                      |
| 6        | Host .2 OfficeCLI behavior                                     | Fixed in host #2 / .3+. Studio integration is #35; this branch does not duplicate its host pin. Bundling OfficeCLI for offline first use remains to be accepted in Studio.                                                                                                                                   |
| 7        | Host OfficeCLI update/reinstall                                | Same host/#35 boundary. Missing bundled OfficeCLI still needs visible installed-app acceptance.                                                                                                                                                                                                              |
| 8        | Host builtin remote-install/tunnel/Moltbook content            | Retired by host #2 / .3+. #35 owns delivery. User-imported content and user-configured MCP/channel connections remain supported.                                                                                                                                                                             |
| 9        | Monaco loader defaults to jsDelivr                             | Pending: bundle the editor and workers. `monaco-editor` is not a direct installed dependency here. Adding it changes #35's `package.json`; the editor is retained until that integration can be made.                                                                                                        |
| 10       | Chat Markdown creates remote images automatically              | HTTP(S) and protocol-relative images require a click, including streaming source changes. Failure is visible and retry is explicit. Inline data/blob and local images remain. `srcSet` is not forwarded by the image renderer. General raw-HTML embedded resources are not a renderer-wide allowlist.        |
| 11       | Preview image failure falls back to original URL               | #35 owns `MarkdownViewer.tsx`, its new error strings and tests. Not changed here.                                                                                                                                                                                                                            |
| 12       | Non-URL browser input goes to Bing                             | Retained pending a configurable search-template design. Removing search or making it unusable is outside the noninteractive boundary. Explicit URL navigation is preserved.                                                                                                                                  |
| 13       | Image-provider calls add AionUi referral headers               | Removed. Explicit provider `baseConfig.defaultHeaders` and configured endpoints are preserved.                                                                                                                                                                                                               |
| 14       | Host npm/npx defaults                                          | Fixed by host #2 / .3+. #35 owns the pin and settings forwarding. Studio also preflighted disabled chrome-devtools entries; this draft skips that preflight and preserves explicit enablement. The default in-app browser MCP still needs offline bundling.                                                  |
| 15       | Build downloads unpinned AionHub `dist-latest`                 | Still present. Next step: retain functionality with an immutable version/hash manifest or offline resource import; do not silently drop bundled features.                                                                                                                                                    |
| 16 (new) | Browser MCP uses npx and upstream usage statistics             | Disabled chrome-devtools preflight is skipped. The Studio-owned pinned browser MCP opts out of usage statistics and npm background notices, preserving user registry settings. Offline bundling of the MCP remains open.                                                                                     |

Provider/OAuth, explicit MCP, channels, speech recognition, WebUI and local Team
connections are retained. Internal endpoint/CA/proxy UI, extension-wheel and
Analytics offline import, and five-target closed-network installation remain
separate unfinished G12 obligations.

## Causes and measurements

The immutable #35 input is head `a141d456759e48636e6972cb1f458b1a5644c7d5`,
[run 41643585460](https://github.com/handochan/aelix-studio/actions/runs/41643585460).
Its Linux arm64 report has 232 external attempts / 0 unparsed; x64 has 238
external attempts **plus 4 unparsed records**. Neither original report contains
PID/comm. The 4 unparsed records are not included in the external-attempt count.

| Original arm64 destination group               | Attempts | Attribution limit                                                                                           |
| ---------------------------------------------- | -------: | ----------------------------------------------------------------------------------------------------------- |
| Google IPv6 address `2001:4860:4860::8888:443` |       23 | Chromium route-reachability probe, not evidence of a DoH request                                            |
| DNS port 53                                    |       13 | Original report has no requesting process or query names                                                    |
| Google IPv4/IPv6 addresses, port 0             |       64 | Consistent with address-selection probes; original socket types/PIDs unavailable                            |
| Google addresses, HTTPS                        |        7 | Dictionary endpoints reproduced independently; historical requests not individually attributable            |
| npm registry address set, port 0               |      120 | Destination matches live `registry.npmjs.org` resolution; process/feature unresolved in the original report |
| npm registry address set, HTTPS                |        5 | Same original attribution limit; not presumed to be Electron                                                |

In local Linux arm64 Docker (Electron 37.10.3), a fresh installed #35 app opening
its first page made 10 attempts, all on `Chrome_ChildIOT`: 4 DNS, 3 HTTPS and 3
IPv6 probes. A recreated run of its 21 UI checks made 35 attempts / 0 unparsed,
again on `Chrome_ChildIOT` (28 IPv6 probes, 4 DNS, 3 HTTPS). Adding system-PATH
Node/npm reproduced the UI checks but did not reproduce the historical npm
network attempts. Counts depend on DNS/cache/platform; the 35 is not a
reclassification of the historical 232.

This local recreated driver reuses the installed .3 host/native payload and the
original UI flow, but bypasses the preparation-receipt check because the CI
artifact does not include the original preparation wheel cache. It is diagnostic
reproduction, **not** installer acceptance. The new CI gate performs fresh
preparation and retains the original verification.

Synthetic-only NetLogs show `redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic`
and its `gvt1.com` redirect. A `spellcheck:false` BrowserWindow and the generic
background switches alone did not prevent dictionary download. A diagnostic
`session-created` hook clearing languages prevented it, but that hook is not
shipped: it disables a user-visible feature without providing a replacement.

The [Electron spellchecker documentation](https://www.electronjs.org/docs/latest/tutorial/spellchecker/)
provides an explicit dictionary endpoint API. Chromium 138's
[resolver request](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager_request_impl.cc)
also starts an IPv6 reachability check even for loopback HTTP requests. Its
[manager](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/net/dns/host_resolver_manager.cc)
uses the fixed Google IPv6 address; generic background-network flags and turning
off DoH do not establish zero attempts.

A later production-default CI audit at head `fb0d6ee8e` started successfully and
reported 81 attempts / 0 unparsed on Linux x64. It attributed npm-address calls
to `npm exec chrome` / libuv threads, not Chromium alone. Source review identified
`runBackendMigrations.ts` preflighting `chrome-devtools` even when disabled, and
the default in-app browser MCP spawning pinned `chrome-devtools-mcp` via npx.
The disabled preflight is now skipped; explicitly enabled MCP behavior is
retained. The pinned 0.16.0 SDK's
[main](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v0.16.0/src/main.ts)
enables Clearcut by default, and its
[sender](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v0.16.0/src/telemetry/watchdog/clearcut-sender.ts)
uses `play.googleapis.com/log`. The owned browser launcher now supplies
`--no-usage-statistics` and `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`, and disables
npm update-notifier/audit/fund. Registry configuration remains unchanged. This
identifies another cause behind Google-address requests; it does not assign every
historical request without its missing PID/argv evidence. The in-app browser MCP needs offline bundling or a user-selected
installation step; it is not silently disabled here. The same run's session audit
failed before app launch because its driver used system Python; the workflow now
uses the prepared native Python, retaining the receipt verification.

## Gate and decisions

`studio-outbound.yml` adds a failing whole-installed-app CI job for both Linux
architectures. It traces the installed Electron, host, ACP, native and driver
processes through synthetic sessions, permission changes and process restarts.
It requires zero external attempts and zero unparsed records, and separately
requires detection of two descendant TCP/UDP positive-control attempts. There
is no report-only or address-exception escape. A proxy or missing strace fails
closed. Branch-protection configuration is not changed by this PR.

The #35 policy snapshot is copied without edits into `scripts/outbound-audit/destinationPolicy.py`; no #35 file is changed. Its later module/API split is kept separate. The wrapper adds
PID/comm and terminal interruption accounting. Incomplete addresses or missing
terminal evidence still fail. Audit artifacts contain no syscall payloads or
command arguments. Raw NetLogs are local diagnostics only and are not uploaded.

The gate is expected to expose remaining defaults until the following steps are
finished. Green unit tests do not establish a zero-attempt app.

1. **Spellchecking:** recommended: bundle pinned dictionaries for supported
   languages, preserving offline use. Alternative: explicitly configured internal
   dictionary endpoint. Default-off with explicit opt-in is another choice; do
   not silently disable the feature.
2. **IPv6 route probe:** evaluate a supported Electron/Chromium version or a small
   maintained engine patch that uses OS/local routing information. Preserve
   user-configured IPv6 endpoints; do not disable IPv6 globally or exempt Google
   from the audit. An Electron dependency change is also held at #35's manifest.
3. **Browser MCP:** recommended: bundle the pinned chrome-devtools MCP and its dependencies, preserving browser control offline. Alternatives are an internal package source with explicit installation, or default-off with user opt-in. Do not disable browser control silently. This dependency work also needs manifest integration after #35.
4. **Monaco:** bundle the editor/workers after #35, with no feature loss. This
   follows the existing decision and needs integration, not a new approval to
   remove the editor.
5. **Browser search:** recommended: no implicit public search provider and an
   explicit user-configured template; retain navigation and show a reason for
   non-URL input before search is configured. Alternative: internal search URL.
6. **Hub and offline delivery:** pin all resource inputs and hashes, then add
   offline import and final five-target tests. Disabling or removing visible
   features is not assumed.

The production-startup NetLog also exposed a hidden release lookup:
`restoreDownloadedUpdateIfAvailable` checked GitHub on every renderer mount.
The same default-off policy now covers cache restoration, including an explicit
disable override. Opt-in restoration preserves hash validation of a real cache;
an empty cache never triggers this lookup. Manual update checks remain available.
Old cache notification restoration without opt-in is intentionally part of turning
off automatic checking; it does not prevent an explicit manual check/install.

The reused permission fixture disables CDP and automatic-update test paths. The
separate production-startup audit has those defaults on but does not exercise a
browser-tool call. Offline first use of the browser MCP still needs explicit
installed-app verification after bundling. Some hard-exit traces contain strace
`???` records. They remain unparsed and fail closed; a measured connection count
with such records is not complete evidence.

macOS and Windows syscall-level attempt measurements have not been performed.
Windows CI separately exercises the local installer-report exporter. A sampled
connection list or successful offline smoke would not replace an attempt audit.

## Local source validation

The source gate passed lint (warnings retained), format, TypeScript and all 13
locale checks. Vitest: **5,023 passed / 7 skipped**; audit tests: **9 passed on Linux** (including a real blocked-thread exit) and **2 startup-environment tests passed**.
A real descendant TCP/UDP positive control detected **2 attempts / 0 unparsed**
and correctly exited 86. The earlier coverage run completed at **54.24% statements**;
it predates the final chat-image change and does not meet the repository's 80%
target. Initial package compilation passed; final-head installer/OS acceptance,
independent Claude review and remaining zero-attempt work are still required.

The standalone Windows exporter uses the same existing report keys in all 13
locales. Its committed JSON mirror is regenerated with
`node scripts/outbound-audit/buildInstallerReportLocales.mjs`; a parity test guards
against translation drift. The NSIS helper bundles that JSON beside the script.
