# Self-hosting and network review

Reviewed 2026-10-23 (Asia/Seoul) against AionUi v2.2.2 / AionCore v0.2.2 and the
Studio follow-up changes. This distribution removes routine frontend diagnostics
and update traffic. It does not sandbox arbitrary agent commands, user HTML,
provider SDKs, or the unchanged backend binary.

## Authentication

Desktop already bypasses the WebUI login and uses its local backend. No vendor
account is required. Keep WebUI's local server login: the server exposes tools,
files and agent execution. Removing the screen without replacing server-side
authorization would expose those capabilities to anyone who can reach it.

The inherited standalone launcher always passed `--local`, disabling API
authentication even when the login screen was visible. Studio now prepares the
agent/account on a private loopback setup backend, stops it, then starts the
public backend with authentication enabled. Provisioning failures prevent the
public listener from opening. GET `/login` serves the SPA instead of consuming
the backend login rate limit. Incoming `x-aionui-internal` headers are stripped.
Desktop backend LAN sharing is disabled because that embedded backend uses local
authentication bypass; use the standalone host for authenticated remote access.

The login now explains local server authentication in every configured language.
It uses Arco controls and theme tokens. Legacy reversible browser passwords are
removed when the login page mounts; new credentials are never written to
localStorage. Remember-me is passed to the server to control session lifetime.
Initial server credentials appear only in operator logs. Preserve those logs as
private and configure credentials before sharing access.

The inherited WebUI account system is not proof of per-user workspace/process
isolation or enterprise SSO. These deployment properties still need dedicated
acceptance for a shared, untrusted multiuser service.

## Native WebUI

Prepare the backend and host-native Studio runtime, then build and launch:

```sh
bun install --frozen-lockfile
node scripts/prepareAioncore.js
bun run studio:runtime
bun run package
bun run webui:prod -- --no-build
```

The standalone default data directory is `~/.aelix-studio-web` in production
(`-dev` / `-dev-2` for development). It is independent from upstream AionUi and the
Electron app. To choose a data path, set `AIONUI_DATA_DIR` or pass `--data-dir`.
Studio keeps inherited `AIONUI_*` environment names for backend compatibility.
The standalone host now registers the same bundled Aelix agent as desktop and
reports the real application version. Both setup and public backend processes
use `--managed-resources-mode bundled`, preventing automatic Node download
fallback. Missing required bundles fail locally. Stop the standalone server
before running `NODE_ENV=production bun run resetpass` against the same data path,
then restart it; no unauthenticated public password-reset endpoint is exposed.

Loopback is the default. `--remote` / `AIONUI_ALLOW_REMOTE=1` exposes the service
on the LAN. Use an internal HTTPS reverse proxy and retain server authentication.
`AIONUI_OPEN_BROWSER=0` prevents browser auto-opening. Browser requests use the
same-origin proxy; the backend's own local port should remain private.

## Docker

The previous Dockerfile called deleted server-build commands, used Node 20 and
omitted workspace manifests during installation. It now builds the renderer,
pinned backend and Studio Python runtime with Node 24, Bun 1.4.4 and uv 0.11.19,
then launches the existing standalone host. Runtime startup performs no package
installation. `.local`, generated host binaries, `.env` files and logs are excluded
from the build context. The image currently retains application dependencies;
image slimming is not part of this change.

```sh
docker build -t aelix-studio:local .
docker run --name aelix-studio -p 127.0.0.1:3000:3000 -v aelix-studio-data:/data aelix-studio:local
# Transfer a prepared image into an isolated network:
docker save -o aelix-studio.tar aelix-studio:local
# On the destination:
docker load -i aelix-studio.tar
```

Use your internal image registry/tag policy for deployment. A connected build is
required for the base images, npm packages, Python wheels and pinned backend/ACP
archives. Published Studio images are not provided by this repository change.
The volume holds server data and ACP state. Aelix model configuration and provider
credentials must be supplied separately using the operator's normal configuration;
they are not bundled into the image or runtime.

## External traffic inventory

| Path                                                                   | Default behavior after this change                                                        | Decision                                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Sentry Electron events/crashes, stable device ID, startup log archive  | SDK disabled, no identifier creation or scheduled upload                                  | Disabled                                                       |
| Backend inherited `SENTRY_DSN` / `SENTRY_AUTH_TOKEN`                   | Removed from child environment                                                            | Disabled inheritance; binary internals remain upstream         |
| Windows installer error reports                                        | Empty DSN independent of build environment                                                | No report endpoint configured                                  |
| Automatic Studio release checks                                        | No startup timer                                                                          | Disabled; About's explicit manual check remains                |
| Upstream version check                                                 | Explicit CLI / PR / manual workflow only                                                  | Build-maintenance function; no runtime automatic check         |
| HTML source editor                                                     | Bundled CodeMirror                                                                        | CDN editor removed                                             |
| Markdown remote images, including raw HTML `<img>`                     | Replaced by links; no image request on rendering                                          | User opens explicitly                                          |
| App/PWA assets, login fonts                                            | Local assets / system fonts                                                               | No hosted assets required                                      |
| Provider API, OAuth, speech/image services                             | Requested by configured feature/provider                                                  | Use internal endpoints or leave unconfigured                   |
| Telegram/Lark/DingTalk/WeChat and other channel integrations           | Require operator configuration                                                            | Retained as optional; do not configure on isolated deployments |
| Extension/skill catalogs, managed CLI/office preview installers        | Managed startup uses bundled mode; optional feature-specific installers still need review | Avoid network-install actions; preprovision approved tools     |
| Browser tabs, HTML/PDF/office previews, user themes and generated HTML | User content can load scripts, fonts, images or URLs                                      | Review content and apply deployment egress policy              |
| Arbitrary commands run by Aelix or another agent                       | Tools have the user's filesystem/network privileges                                       | ACP approval is not a network sandbox                          |
| Sentry build source-map uploads                                        | Plugin removed, including automatic upload from inherited build credentials               | Disabled                                                       |
| Online feedback submission                                             | Rejected before collecting diagnostics; localized explanation in the dialog               | Disabled                                                       |
| Build dependencies and release publishing                              | Build/release host only                                                                   | Stage artifacts before network isolation                       |

No channel/provider functionality was removed wholesale. This keeps the downstream
diff small while disabling unneeded automatic traffic. A fully restricted network
must still be enforced by the deployment network policy and tested with actual
internal providers, required tools and previews. Disconnected startup/ACP checks
only establish those measured flows; they do not prove every optional feature is
offline-compatible.

See [distribution-status.md](distribution-status.md) for commands actually run and
[windows.md](windows.md) for Windows acceptance requirements.
