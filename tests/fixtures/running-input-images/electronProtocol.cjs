const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');

const fixture = process.argv[2];
assert.ok(fixture, 'Pass the loopback browser matrix URL');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-worker-protocol-'));
app.setPath('userData', userData);
app.on('will-quit', () => fs.rmSync(userData, { recursive: true, force: true }));

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'studio-worker-fixture',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

app
  .whenReady()
  .then(async () => {
    protocol.handle('studio-worker-fixture', async (request) => {
      const { pathname, search } = new URL(request.url);
      const target = new URL(pathname + search, fixture);
      const headers = new Headers(request.headers);
      headers.delete('host');
      headers.delete('content-length');
      const init = { method: request.method, headers };
      if (request.body) {
        init.body = request.body;
        init.duplex = 'half';
      }
      const response = await fetch(target, init);
      return new Response(response.status === 204 ? null : await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
      });
    });
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    const timer = setTimeout(() => app.exit(1), 30_000);
    window.webContents.on('did-finish-load', async () => {
      try {
        const report = await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const element = document.querySelector('pre');
          if (element.textContent) return resolve(JSON.parse(element.textContent));
          new MutationObserver(() => resolve(JSON.parse(element.textContent)))
            .observe(element, { childList: true, characterData: true, subtree: true });
        })
      `);
        assert.ok(
          report.results.every(({ result }) => result === 'passed'),
          JSON.stringify(report.results)
        );
        console.log(JSON.stringify({ origin: 'studio-worker-fixture://studio', ...report }));
        clearTimeout(timer);
        app.quit();
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
    await window.loadURL('studio-worker-fixture://studio/');
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
