/** Real Linux/Windows Electron spelling fixture: no external assets or credentials. */
const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const output = process.env.SPELLCHECK_SMOKE_REPORT;
const compiled = process.env.SPELLCHECK_SERVER_MODULE;
const directory = process.env.SPELLCHECK_ASSET_DIR;
assert.ok(output && compiled && directory, 'Explicit fixture paths required');
app.setPath('userData', process.env.SPELLCHECK_USER_DATA);
app.commandLine.appendSwitch('disable-gpu');
const timer = setTimeout(() => {
  console.error('Offline spellcheck fixture timed out');
  app.exit(1);
}, 25000);
app
  .whenReady()
  .then(async () => {
    const { createDictionaryServer } = require(compiled);
    const { server, url } = await createDictionaryServer(directory);
    app.once('will-quit', () => server.close());
    const ses = session.defaultSession;
    ses.setSpellCheckerDictionaryDownloadURL(url);
    const initialized = new Promise((resolve, reject) => {
      ses.once('spellcheck-dictionary-initialized', (_event, language) => resolve(language));
      ses.once('spellcheck-dictionary-download-failure', () => reject(new Error('Local dictionary failed')));
    });
    ses.setSpellCheckerLanguages(['en-US']);
    const win = new BrowserWindow({
      show: false,
      webPreferences: { spellcheck: true, nodeIntegration: true, contextIsolation: false },
    });
    await win.loadURL('data:text/html,<textarea autofocus>helooo</textarea>');
    const language = await initialized;
    const result = await win.webContents.executeJavaScript(
      "({misspelled:require('electron').webFrame.isWordMisspelled('helooo'),correct:require('electron').webFrame.isWordMisspelled('hello'),suggestions:require('electron').webFrame.getWordSuggestions('helooo')})"
    );
    assert.equal(result.misspelled, true);
    assert.equal(result.correct, false);
    assert.ok(result.suggestions.includes('hello'));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ status: 'passed', language, ...result }) + '\n');
    clearTimeout(timer);
    win.destroy();
    server.close();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
