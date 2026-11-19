# Aelix Studio app identity

Studio uses the display name **Aelix Studio**, application ID `ai.aelix.studio`,
and URL scheme `aelix-studio://`. The desktop installer filenames begin with
`aelix-studio-`. The Linux package and executable are `aelix-studio`. macOS
and Windows use `Aelix Studio.app` and `Aelix Studio.exe`.

| Profile or resource            | Default location                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| macOS desktop profile          | `~/Library/Application Support/Aelix Studio`                                                    |
| Windows desktop profile        | `%APPDATA%\Aelix Studio`                                                                        |
| Linux desktop profile          | `$XDG_CONFIG_HOME/Aelix Studio` or `~/.config/Aelix Studio`                                     |
| Desktop settings and host data | `config/` and `aelix-studio/` within the profile                                                |
| Desktop app logs               | `~/Library/Logs/Aelix Studio` on macOS, `logs/` within the desktop profile on Windows and Linux |
| Standalone WebUI data and logs | `~/.aelix-studio-web` and its `logs/` subdirectory                                              |

Desktop and bundled WebUI use the Studio profile, which Electron also uses for
its single-instance lock. Development uses `Aelix Studio-Dev` or
`Aelix Studio-Dev-2`. On macOS the CLI-safe symlinks are `~/.aelix-studio`
and `~/.aelix-studio-config`, with corresponding development suffixes.
Standalone WebUI source commands use `-dev` or `-dev-2` outside production.
An explicit standalone `--data-dir` or `AIONUI_DATA_DIR` selects another directory.
A first launch starts with a fresh profile and leaves the upstream app's
profiles, temporary data, and URL registration independent.

## Upstream and compatibility names

- The source package and workspaces (`AionUi`, `@aionui/*`) and the compiled
  WebUI CLI command (`aionui-web`) retain their internal names for upstream
  compatibility. Product metadata is applied during desktop packaging.
- Existing `AIONUI_*` environment variables, `x-aionui-*` headers,
  `AIONCORE_*` process messages, `bundled-aioncore` resources, and
  `aionui-backend.db` are host and runtime interfaces.
- Internal CSS selectors, renderer storage keys, config filenames inside the
  Studio profile, diagnostic prefixes, and installer macros remain compatible
  with existing code and downstream tools.
- Upstream-only assets, the discontinued upstream release letter, and upstream
  and historical documentation retain their original attribution. Studio is
  derived from [AionUi](https://github.com/iOfficeAI/AionUi) under
  [Apache-2.0](../../LICENSE).
- The Studio mark and wordmarks are copied from the
  [Aelix brand sources](https://github.com/handochan/aelix-ai/tree/1c2a4a7c70c0bcb1bb103e6fbabd8967fd65e21c/docs/assets/brand).
  App and PWA raster assets use the original mark from the Studio bootstrap
  commit `41a1016f8`.
