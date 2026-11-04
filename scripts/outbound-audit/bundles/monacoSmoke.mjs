/** Render the real local editor and exercise its HTML worker with egress blocked. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'vite';
import { _electron as electron, expect } from '@playwright/test';
import { isolatedAppEnvironment } from '../startup.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../../..');
const output = path.resolve(process.argv[2]);
const directory = await fs.mkdtemp(path.join(root, '.local/monaco-offline-'));
const source = path.join(
  root,
  'packages/desktop/src/renderer/pages/conversation/Preview/components/editors/OfflineMonacoEditor.tsx'
);
const report = { schema: 'aelix.monaco-offline/1', status: 'failed', externalRequests: 0, credentials: false };
let server, app, dictionaries;
try {
  await fs.writeFile(
    path.join(directory, 'index.html'),
    '<html><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>'
  );
  await fs.writeFile(
    path.join(directory, 'main.tsx'),
    `import React from 'react';import {createRoot} from 'react-dom/client';import i18next from 'i18next';import {I18nextProvider} from 'react-i18next';import Editor from ${JSON.stringify(source)};
    await i18next.init({lng:'en-US',resources:{'en-US':{translation:{common:{loading:'Loading'},preview:{localEditorUnavailable:'Local editor unavailable'}}}}});
    window.__workerUrls=[];window.__workerErrors=0;const NativeWorker=window.Worker;window.Worker=class extends NativeWorker{constructor(url,options){super(url,options);window.__workerUrls.push(String(url));this.addEventListener('error',()=>window.__workerErrors++);}};
    createRoot(document.getElementById('root')).render(<I18nextProvider i18n={i18next}><Editor height='400px' language='html' value='<h1>OFFLINE_EDITOR</h1>' onMount={(editor,monaco)=>{window.__testEditor=editor;window.__testMonaco=monaco;}}/></I18nextProvider>);`
  );
  await build({
    configFile: false,
    root: directory,
    base: './',
    logLevel: 'error',
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
    worker: { format: 'es' },
  });
  const compiled = path.join(directory, 'dictionaryServer.cjs');
  require('esbuild').buildSync({
    entryPoints: [path.join(root, 'packages/desktop/src/process/resources/dictionaryServer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: compiled,
  });
  if (process.platform !== 'darwin')
    dictionaries = await require(compiled).createDictionaryServer(path.join(root, '.local/offline-spellcheck'));
  const dist = path.join(directory, 'dist');
  server = http.createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(dist + path.sep)) {
        response.writeHead(404);
        response.end();
        return;
      }
      const bytes = await fs.readFile(file);
      const type = file.endsWith('.html')
        ? 'text/html'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.js')
            ? 'text/javascript'
            : 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      response.end(bytes);
    })().catch(() => {
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const entry = path.join(directory, 'app.cjs');
  await fs.writeFile(
    entry,
    `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',process.env.MONACO_USER_DATA);app.commandLine.appendSwitch('disable-gpu');if(process.env.MONACO_DICTIONARY_URL)app.on('session-created',s=>s.setSpellCheckerDictionaryDownloadURL(process.env.MONACO_DICTIONARY_URL));app.whenReady().then(()=>{const w=new BrowserWindow({show:false});w.loadFile(process.env.MONACO_FIXTURE_FILE)});app.on('window-all-closed',()=>app.quit());`
  );
  const env = isolatedAppEnvironment(directory);
  for (const name of [
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'AELIX_CODING_AGENT_DIR',
    'AELIX_CODING_AGENT_SESSION_DIR',
  ])
    await fs.mkdir(env[name], { recursive: true });
  env.MONACO_USER_DATA = path.join(directory, 'profile');
  await fs.mkdir(env.MONACO_USER_DATA);
  env.MONACO_FIXTURE_FILE = path.join(dist, 'index.html');
  if (dictionaries) env.MONACO_DICTIONARY_URL = dictionaries.url;
  app = await electron.launch({
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), entry],
    env,
    cwd: root,
    timeout: 60000,
  });
  const external = [];
  await app.context().route('**/*', (route) => {
    const target = new URL(route.request().url());
    if (['http:', 'https:'].includes(target.protocol) && target.hostname !== '127.0.0.1') {
      external.push(target.host);
      return route.abort();
    }
    return route.continue();
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.__testEditor), undefined, { timeout: 45000 });
  await expect(page.locator('.monaco-editor')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__testEditor.getAction('editor.action.formatDocument')?.isSupported()), {
      timeout: 20000,
    })
    .toBe(true);
  const result = await page.evaluate(async () => {
    const editor = window.__testEditor;
    const monaco = window.__testMonaco;
    editor.setValue('<html><body><div><b>OFFLINE_EDITED</b></div></body></html>');
    const model = editor.getModel();
    await editor.getAction('editor.action.formatDocument').run();
    return {
      value: editor.getValue(),
      language: model.getLanguageId(),
      workerUrls: window.__workerUrls,
      workerErrors: window.__workerErrors,
    };
  });
  assert.ok(result.value.includes('OFFLINE_EDITED') && result.value.includes('\n'), 'HTML formatting must execute');
  assert.equal(result.language, 'html');
  assert.equal(result.workerErrors, 0);
  assert.ok(result.workerUrls.length > 0, 'Editor must start a bundled worker');
  assert.deepEqual(external, [], 'The local editor must not request any remote resource');
  const { workerUrls, ...details } = result;
  Object.assign(report, details, {
    status: 'passed',
    externalRequests: external.length,
    workerFiles: workerUrls.map((url) => path.basename(new URL(url).pathname)),
  });
} finally {
  await app?.close();
  dictionaries?.server.closeAllConnections();
  dictionaries?.server.close();
  server?.closeAllConnections();
  server?.close();
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await fs.rm(directory, { recursive: true, force: true });
}
