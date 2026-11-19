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
| Desktop settings and host data | `config/` and `aionui/` within the profile                                                      |
| Desktop app logs               | `~/Library/Logs/Aelix Studio` on macOS, `logs/` within the desktop profile on Windows and Linux |
| Standalone WebUI data and logs | `~/.aelix-studio-web` and its `logs/` subdirectory                                              |

Desktop and bundled WebUI use the Studio profile, which Electron also uses for
its single-instance lock. Development uses `Aelix Studio-Dev` or
`Aelix Studio-Dev-2`. On macOS the CLI-safe symlinks are `~/.aelix-studio`
and `~/.aelix-studio-config`, with corresponding development suffixes.
The private `aionui/` database subdirectory lets the extension runtime discover
the same profile from a direct Desktop database path or the macOS CLI-safe
symlink. The extension state remains at `<Studio profile>/aelix-runtime`.
Standalone WebUI source commands use `-dev` or `-dev-2` outside production.
An explicit standalone `--data-dir` or `AIONUI_DATA_DIR` selects another directory.
A first launch starts with a fresh profile and leaves the upstream app's
profiles, temporary data, and URL registration independent.

## WebUI defaults

The default browser address is `http://aelix-studio.localhost:25982`. Development
uses port `25983`, and a second development instance uses `25984`. An explicit
port or saved preference takes priority. The local listener still binds IPv4
loopback unless remote access is enabled. Browser navigation from the old raw
loopback aliases is redirected to the Studio hostname.

Studio publishes host-only `aelix-studio-session`, `aelix-studio-refresh`, and
`aelix-studio-csrf-token` cookies. Session and refresh cookies use `HttpOnly`.
The session and CSRF cookies use `Path=/`, and the refresh cookie uses
`Path=/api/auth/refresh`. Local HTTP uses `SameSite=Lax`. HTTPS uses
`SameSite=Strict` and `Secure` when the host enables HTTPS cookies or Studio
serves the configured HTTPS origin. The WebUI proxy maps only Studio
credentials to the pinned host. Existing browser sessions require a new login.

For two remote deployments on the same machine, use a dedicated browser
hostname for Studio. Cookies do not distinguish ports, so a shared LAN address
with different ports cannot isolate cookie delivery.
[RFC 6265, Weak Confidentiality](https://www.rfc-editor.org/rfc/rfc6265#section-8.5).

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
