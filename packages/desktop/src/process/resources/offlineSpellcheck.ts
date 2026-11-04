/** Preserve native macOS spelling; Linux/Windows use the pinned local dictionary feed. */
import { app, session } from 'electron';
import path from 'node:path';
import { createDictionaryServer } from './dictionaryServer';

export async function initializeOfflineSpellcheck(): Promise<void> {
  if (process.platform === 'darwin') return;
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, 'offline-spellcheck')
    : path.join(app.getAppPath(), '.local/offline-spellcheck');
  const { server, url } = await createDictionaryServer(directory);
  app.on('session-created', (created) => created.setSpellCheckerDictionaryDownloadURL(url));
  session.defaultSession.setSpellCheckerDictionaryDownloadURL(url);
  app.once('will-quit', () => server.close());
}
