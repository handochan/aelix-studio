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

The preferred browser address is `http://[::1]:25982`. Development uses
port `25983`, and a second development instance uses `25984`. The IPv6
listener binds only to loopback and requires no DNS resolution in Safari.
The existing IPv4 listener binds to loopback unless remote access is enabled.
If the IPv6 endpoint is unavailable, Studio advertises `127.0.0.1` instead.
Explicit ports and saved preferences take priority. Desktop settings display,
copy, and open the address returned by the running listener. A proxy configured
through `AELIX_STUDIO_ORIGIN` retains its scheme, hostname, and public port.

Studio publishes host-only `aelix-studio-session`, `aelix-studio-refresh`, and
`aelix-studio-csrf-token` cookies. Session and refresh cookies use `HttpOnly`.
The session and CSRF cookies use `Path=/`, and the refresh cookie uses
`Path=/api/auth/refresh`. Local HTTP uses `SameSite=Lax`. HTTPS uses
`SameSite=Strict` and `Secure` when the host enables HTTPS cookies or Studio
serves the configured HTTPS origin. The WebUI proxy maps only Studio
credentials to the pinned host. Existing browser sessions require a new login.

Use distinct hostnames when serving Studio and AionUi remotely. On one device,
use separate browser profiles or distinct hostnames. Cookies are scoped by
host, so applications on the same hostname can receive the same cookies even
if their ports differ. This also applies if Studio falls back to IPv4.
[RFC 6265, Weak Confidentiality](https://www.rfc-editor.org/rfc/rfc6265#section-8.5).

## Standalone WebUI installation

The release asset is `install-aelix-studio-web.sh`. When the Beta assets are
published, download it from
`https://github.com/handochan/aelix-studio/releases/download/v<VERSION>/install-aelix-studio-web.sh`.
Use the complete version from the tag, including any prerelease suffix. The
installer reads the matching `aelix-studio-web-<VERSION>-<OS>-<ARCH>.tar.gz`
and `.tar.gz.sha256` from the same release. An offline mirror may use
`--mirror file:///path/to/releases`, with the tarball and checksum in a
`v<VERSION>/` subdirectory.

```bash
bash install-aelix-studio-web.sh --no-path
~/.local/bin/aelix-studio-web start --no-open
```

The installer defaults to `~/.local/share/aelix-studio-web` and links the
command at `~/.local/bin/aelix-studio-web`. The data and logs default to
`~/.aelix-studio-web` and `~/.aelix-studio-web/logs`. Use
`aelix-studio-web resetpass` while the server is stopped. When starting or
resetting with an alternate data directory, use the same `--data-dir` or
`AIONUI_DATA_DIR` both times. The flag takes priority over the environment.

On Linux with a systemd user manager, start the WebUI in a terminal first to
read the generated operator password. After stopping that instance with
Ctrl+C, you can run the packaged unit in the background.

```bash
mkdir -p ~/.config/systemd/user
cp ~/.local/share/aelix-studio-web/aelix-studio-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aelix-studio-web.service
```

If you installed to a custom directory, adjust the installed unit's
`ExecStart`. To uninstall, stop the foreground process or disable the user
unit with `systemctl --user disable --now aelix-studio-web.service`. If you
copied the unit, remove `~/.config/systemd/user/aelix-studio-web.service` and
run `systemctl --user daemon-reload`. Then remove the Studio link and install
root. Any previous Studio version is kept beside the install root in an
`.backup.*` directory. Keep the Studio data directory if you plan to reinstall.

## Upstream and compatibility names

- The source package and workspaces (`AionUi`, `@aionui/*`) retain their
  internal names. Product metadata is applied during packaging.
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
