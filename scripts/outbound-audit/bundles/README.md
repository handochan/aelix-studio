# Offline application inputs

`spellcheck.json` pins Electron 37.10.3's complete official Hunspell archive,
SHA-256 `5e24e43346b1eea53d2ee6d1be3136d6721196914d332a44deedac326af273f0`.
Chromium 138.0.7204.251 pins dictionary source revision
`41cdffd71c9948f63c7ad36e1fb0ff519aa7a37e`. The manifest records every member's
versioned name, byte count and SHA-256. `spellcheckNotices.json` preserves 47
per-language/source notices byte-for-byte (base64), individually checksummed.
All upstream `COPYING*`/`LICENSE` files and these notices ship in the bundle.
Licenses vary by dictionary; consult the preserved README for each language.

Sources: [Electron asset](https://github.com/electron/electron/releases/tag/v37.10.3),
[Chromium source pin](https://chromium.googlesource.com/chromium/src/+/138.0.7204.251/DEPS),
[dictionary source and licenses](https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/41cdffd71c9948f63c7ad36e1fb0ff519aa7a37e),
[Electron spelling API](https://www.electronjs.org/docs/latest/tutorial/spellchecker).

The archive contains 55 versioned `.bdic` files (including retained older
versions); all are included, without narrowing Electron's supported language
set. It is 34,406,377 bytes compressed / 112,260,879 bytes unpacked, before the
small source notices/index. macOS keeps its native spellchecker; the dictionary
resources are also present in its installer for a uniform resource inventory.

`node scripts/outbound-audit/bundles/spellcheck.cjs` prepares verified inputs into
`.local/offline-spellcheck` during the existing app/MCP build. For a disconnected
build, pre-import the pinned archive as `.local/offline-inputs/spellcheck/dictionaries.zip`.
No downloader ships in the installed app. A loopback-only immutable resource
server supplies case-normalized dictionary names to every Electron session.
Unknown paths, traversal and checksum mismatch fail locally, with no CDN fallback.
The spellchecker stays enabled. The `spellcheckSmoke.cjs` fixture verifies real
Electron dictionary initialization and correction of a misspelled word in a
fresh user profile on Linux with `--network none`.

## Browser MCP

`chrome-devtools-mcp` is an exact development/build input at `0.16.0`, locked in
`bun.lock` with npm integrity
`sha512-Jw+h8OGhpU9UjXl7Mm4yZe8IRzHmC19VNPP48+MI8AkWtCmnsbOsZ0hdoV2oq0veh3T1OcBbZSFHXVpFMBBi9Q==`.
The upstream npm artifact already includes its dependencies under `build/src/third_party`
and has no runtime npm dependency entries. Its complete package (including original
Apache-2.0 license and dependency notices) is copied unchanged beside the wrapper
and unpacked for external Node. No runtime `npx` or npm installer is used.
Source: [upstream 0.16.0](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/chrome-devtools-mcp-v0.16.0).

The in-app wrapper uses `process.execPath` for its child and an absolute sibling
entry. The outer DB transport remains `node [builtin-mcp-browser.js]`; the pinned
host's `probe_runtime_command("node")` selects its existing managed Node, without
entering its npx/registry package resolver. The default-disabled standalone Chrome
row also uses the local package. Only the exact old Studio-owned `npx -y
chrome-devtools-mcp@latest`/`@0.16.0` row migrates, preserving enablement and custom
environment. Customized commands stay user configuration. Disabled-server
preflight remains skipped; bundled Node rows cannot enter the npx preflight.
Host source: [pinned runtime command classification](https://github.com/handochan/aelix-studio-host/blob/c516fa9/crates/aionui-runtime/src/node_runtime/mod.rs).
No host source/pin changes are required.

`browserMcpSmoke.mjs` runs the real wrapper with an empty PATH, an unavailable
registry and no credentials. It verifies initialize version 0.16.0, tools/list
(including navigate_page/list_pages), usage-statistics opt-out and clean shutdown.
The Linux installed-app job repeats it with installed bundled Node and the common
blocking auditor. Local Linux arm64 with no external network returned 26 tools,
external/unparsed/classification 0/0/0. Tool execution against a real page is a
separate browser/host acceptance boundary.

## Monaco

The explicit `monaco-editor` dependency is fixed at 0.55.1 (the version previously
resolved as a peer). The HTML viewer loads it lazily through Vite ESM chunks.
Editor, JSON, CSS, HTML and TypeScript/JavaScript workers all use Vite's local
`?worker` entries. `loader.config({ monaco })` supplies the bundled instance, so
the React loader never needs its default CDN. Original editor capabilities stay
available; a local bundle failure shows a translated recovery explanation.
Integration follows the [maintainer's Vite instructions](https://github.com/suren-atoyan/monaco-react#use-monaco-editor-as-an-npm-package).

`monacoSmoke.mjs` builds the real component and opens it from `file:` with Electron,
matching the packaged renderer origin. It edits an HTML model and formats it via
the real local HTML worker, rejects any remote request and records worker errors.
The macOS engine fixture passed with 0 remote requests and 0 worker errors; that
is renderer-request evidence, not an OS-level outbound audit. Linux CI runs the
same fixture under the common whole-tree blocking auditor.
