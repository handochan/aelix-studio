import { app, BrowserWindow } from 'electron';
import { createJsonFileStore } from '../../packages/desktop/src/process/storage/jsonFile';
import {
  attachWindowBoundsPersistence,
  loadSavedWindowBounds,
} from '../../packages/desktop/src/process/utils/windowBounds';
import { installQuitCleanup } from '../../packages/desktop/src/process/startup/quitCleanup';

// Deliberately small: actual store/window/quit code, hidden window, synthetic
// backend teardown. No model, provider, user profile, or external requests.
const file = process.env.CONFIG_PERSIST_FILE;
if (!file) throw new Error('Set CONFIG_PERSIST_FILE to an owned scratch file');
const store = createJsonFileStore(file);
installQuitCleanup({
  onBeforeQuit: (handler) => app.on('before-quit', handler),
  quitApp: () => app.quit(),
  setIsQuitting: () => {},
  markExplicitQuit: () => {},
  destroyTray: () => {},
  disposeCronResumeListener: () => {},
  stopBackend: () => new Promise((resolve) => setTimeout(resolve, 1000)),
  destroyPetWindow: () => {},
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
});
void app.whenReady().then(() => {
  loadSavedWindowBounds(store.getSync('window.bounds'));
  const window = new BrowserWindow({ show: false, width: 800, height: 650 });
  attachWindowBoundsPersistence(window, (bounds) => store.set('window.bounds', bounds));
  setTimeout(() => app.quit(), 250);
});
