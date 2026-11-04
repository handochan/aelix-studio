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
