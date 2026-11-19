import { app, BrowserWindow } from 'electron';
import { once } from 'node:events';
import http from 'node:http';
import { BackendLifecycleManager, studioBackendCredential } from '@aionui/web-host';
import { protectStudioRequests } from '../../../packages/desktop/src/process/backend/studioRequest';

async function main(): Promise<void> {
  const [, , backend, dataDir] = process.argv;
  app.setPath('userData', dataDir);
  await app.whenReady();

  const manager = new BackendLifecycleManager(
    { version: '1.0.0', isPackaged: false, resourcesPath: dataDir, userDataPath: dataDir },
    () => backend,
    true
  );

  let port = await manager.start(dataDir);
  const origin = () => 'http://127.0.0.1:' + port;
  const fixture = http.createServer((req, res) => {
    const endpoint = req.url ?? '/';
    if (endpoint === '/redirect') {
      res.writeHead(302, { location: origin() + '/checked' }).end();
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (endpoint === '/frame' || endpoint === '/guest') {
      res.end(`<body><script>
        fetch(${JSON.stringify(origin() + '/checked')})
          .then(response => { document.body.textContent = response.status; });
      </script></body>`);
      return;
    }
    res.end('<!doctype html><body>Fixture</body>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable');

  const fixtureUrl = 'http://127.0.0.1:' + address.port + '/';
  const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true } });
  protectStudioRequests(win.webContents.session, new Map([[win.webContents.id, new Set([fixtureUrl])]]));
  await win.loadURL(fixtureUrl);

  Object.assign(globalThis, {
    studioFixture: {
      origin,
      async restart() {
        const first = studioBackendCredential(new URL(origin()));
        await manager.stop();
        port = await manager.start(dataDir);
        const second = studioBackendCredential(new URL(origin()));
        return { origin: origin(), rotated: !!first && !!second && first !== second };
      },
    },
  });

  app.on('before-quit', (event) => {
    event.preventDefault();
    void manager.stop().finally(() => {
      fixture.close();
      app.exit();
    });
  });
}

void main().catch((err) => {
  console.error(err);
  app.exit(1);
});
