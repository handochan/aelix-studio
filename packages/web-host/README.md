# @aionui/web-host

WebUI host package for AionUi - zero Electron dependency.

## Responsibilities

- **backend-launcher**: spawn or reuse existing aioncore process
- **static-server**: serve out/renderer SPA + reverse proxy /api and /ws to backend
- **auth**: password reset, change, verify, config I/O (bcrypt + session)

## Usage

```ts
import { startWebHost } from '@aionui/web-host';

const handle = await startWebHost({
  app: {
    version: '1.0.0',
    isPackaged: false,
    resourcesPath: '/path/to/resources',
    userDataPath: '/path/to/userData',
  },
  staticDir: '/path/to/out/renderer',
  backend: {
    kind: 'ownBackend',
    resolveBackend: () => '/path/to/aioncore',
  },
});

console.log(`WebUI running at ${handle.url}`);

await handle.stop();
```

## Request origins

The listener defaults to IPv4 loopback. Its HTTP and WebSocket endpoints accept
the listener's port on `127.0.0.1` or `localhost`. When remote access is enabled,
they also accept the machine's current IPv4 addresses without restarting after
a Wi-Fi or VPN change. Reopen the desktop WebUI settings to read the current
network URL. The standalone CLI prints the address present at startup. After a
network change, use the machine's current IPv4 address with the same port.
WebSocket upgrades and state-changing HTTP requests require an Origin matching
the request's Host.
Normal page and asset loads can omit the Origin header.

A reverse proxy can use the existing `AELIX_STUDIO_ORIGIN` setting to declare
its browser-facing origin. Preserve the browser-facing Host when forwarding
requests, including WebSocket upgrades.

The listener removes forwarded client IP headers before sending login requests
to the backend. Behind a reverse proxy, devices share the backend's login rate
limit. Failed attempts from one device can cause HTTP 429 for password or QR
login requests from another device.

## Status

M3: skeleton + type definitions + placeholder implementations (all throw `not implemented yet`)
