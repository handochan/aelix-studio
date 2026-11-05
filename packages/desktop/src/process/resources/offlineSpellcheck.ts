/** Preserve native macOS spelling and keep every dictionary failure local and visible. */
import { app, dialog, session, type Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDictionaryServer } from './dictionaryServer';

export async function initializeOfflineSpellcheck(): Promise<void> {
  if (process.platform === 'darwin') return;
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, 'offline-spellcheck')
    : path.join(app.getAppPath(), '.local/offline-spellcheck');
  // Even a bind/missing-resource failure must never leave Chromium's CDN default.
  let url = pathToFileURL(path.join(app.getPath('userData'), 'unavailable-spellcheck/')).href;
  let notified = false;
  const unavailable = (): void => {
    if (notified) return;
    notified = true;
    void import('../services/i18n')
      .then(async ({ default: i18n, setInitialLanguage }) => {
        await setInitialLanguage(undefined);
        await dialog.showMessageBox({
          type: 'warning',
          title: i18n.t('preview.localSpellingUnavailableTitle'),
          message: i18n.t('preview.localSpellingUnavailableDescription'),
          buttons: [i18n.t('common.confirm')],
        });
      })
      .catch((error: unknown) => console.error('[spellcheck] Could not display recovery notice', error));
  };
  const configured = new WeakSet<Session>();
  const configure = (created: Session): void => {
    created.setSpellCheckerDictionaryDownloadURL(url);
    if (!configured.has(created)) {
      configured.add(created);
      created.on('spellcheck-dictionary-download-failure', unavailable);
    }
  };
  app.on('session-created', configure);
  try {
    const local = await createDictionaryServer(directory, unavailable);
    url = local.url;
    app.once('will-quit', () => local.server.close());
  } catch (error) {
    console.error('[spellcheck] Bundled dictionaries unavailable', error);
    unavailable();
  }
  configure(session.defaultSession);
}
