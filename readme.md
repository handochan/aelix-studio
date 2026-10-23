# Aelix Studio

A self-hosted desktop and web workspace for **Aelix Coding and Analytics**, maintained as a small
downstream distribution of [AionUi](https://github.com/iOfficeAI/AionUi).

[한국어](docs/readme/readme_ko.md) · [Development and packaging](docs/aelix-studio/README.md) ·
[Windows](docs/aelix-studio/windows.md) · [Self-hosting and network review](docs/aelix-studio/self-hosting.md)

## What is included

- Official Aelix branding, application ID `ai.aelix.studio`, separate application data,
  and a Studio-only update feed.
- Bundled Python **3.12.12**, Aelix **0.1.0b2** and ACP **0.1.0**. No system Python,
  pip, uv or package downloads are required to run a prepared distribution.
- Coding and Analytics registered through the existing backend API for desktop and WebUI,
  with the inherited agent-team feature enabled. Existing user agents, saved choices,
  custom arguments and protected environment overrides are preserved.
- Analytics **0.26.0**, bundled uv **0.11.19**, and a locked offline cache for its
  separate project environments. No system uv or Python is required.
- Explicit approval before each Aelix tool execution. Windows uses authenticated
  loopback TCP; macOS/Linux use a private Unix socket.
- Local server authentication for WebUI. Desktop opens directly without login.
  No external account or Studio cloud service is required.
- Automatic update checks and Sentry event/log uploads disabled. HTML editing uses
  a bundled editor; remote Markdown images load only when their link is opened.

Model credentials are supplied by the operator. An internet model still needs its
provider network; use an internal provider for a closed-network deployment.
Corporate IdP SSO is deferred; single-operator WebUI uses local account authentication.

## Platform status

| Target          | Implementation                                                  | Acceptance                                                                          |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| macOS arm64/x64 | Native runtime, DMG/ZIP packaging and desktop CI                | Local arm64 evidence and remaining native gates are recorded in the status document |
| Windows x64     | Native build, permission transport, installer fixes and CI jobs | Requires an actual Windows installer/UI run; not certified by macOS tests           |
| Linux arm64/x64 | Native runtime, `.deb` desktop packaging and WebUI/Docker       | Runtime, desktop and WebUI acceptance are recorded separately                       |
| Windows arm64   | Not enabled for the Studio bundle                               | Pending native wheels and Windows validation                                        |

See [verification and limits](docs/aelix-studio/distribution-status.md). Source changes,
local tests, and configured CI jobs do not imply a published or signed release.
The [review corrections](docs/aelix-studio/review-fixes.md) record the fixed defects and current evidence.

## Build and run

Use Node **22–24**, Bun **1.4.4**, build-time Python **3.9+**, and uv **0.11.19**.
Build on the target OS/architecture.

```sh
bun install --frozen-lockfile
node scripts/prepareAioncore.js
bun run studio:runtime
bun run studio:dist
```

Both Studio commands select the host Python command automatically. See
[the Windows instructions](docs/aelix-studio/windows.md).

For standalone WebUI, prepare the runtimes above and run:

```sh
bun run package
bun run webui:prod -- --no-build
```

For containers, build the image while connected, then transfer the image into the
isolated network. Initial server credentials appear in the private container log.

```sh
docker build -t aelix-studio:local .
docker run --name aelix-studio -p 127.0.0.1:3000:3000 -v aelix-studio-data:/data aelix-studio:local
```

Review [self-hosting configuration and remaining network paths](docs/aelix-studio/self-hosting.md)
before exposing WebUI beyond the local host.

## Upstream tracking

AionUi baseline: **v2.2.2**, commit
`6744099b279b991c17e31c243f0920477bd31cb6`. Backend: unchanged **AionCore v0.2.2**.
The baseline remains separate from Studio's app version and the Aelix runtime lock.

```sh
node scripts/aelix-studio/checkUpstream.mjs
# CI gate: exit 2 when a new tag or changed release commit requires review
node scripts/aelix-studio/checkUpstream.mjs --fail-on-drift
```

[upstream.json](docs/aelix-studio/upstream.json) records provenance. The manual/PR
workflow uploads a JSON report and never merges or updates installed software.
Upstream adoption requires review of the diff, backend version, Windows packaging,
local data compatibility and network behavior.

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).
[Apache-2.0](LICENSE); upstream notices and attribution are preserved in [NOTICE](NOTICE).
Other translated README files retain upstream documentation and are not Studio
release or offline acceptance claims.
