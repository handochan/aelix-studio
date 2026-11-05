import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  show: vi.fn().mockResolvedValue({}),
  close: vi.fn(),
  handlers: new Map<string, Function>(),
  sessionHandlers: new Map<string, Function>(),
  setUrl: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/isolated/user',
    getAppPath: () => '/isolated/app',
    on: vi.fn((name: string, listener: Function) => mocks.handlers.set(name, listener)),
    once: vi.fn(),
  },
  session: {
    defaultSession: {
      setSpellCheckerDictionaryDownloadURL: mocks.setUrl,
      on: vi.fn((name: string, listener: Function) => mocks.sessionHandlers.set(name, listener)),
    },
  },
  dialog: { showMessageBox: mocks.show },
}));
vi.mock('@/process/resources/dictionaryServer', () => ({ createDictionaryServer: mocks.create }));
vi.mock('@/process/services/i18n', () => ({
  default: { t: (key: string) => key },
  setInitialLanguage: vi.fn().mockResolvedValue(undefined),
}));
const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.sessionHandlers.clear();
  Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
  mocks.create.mockResolvedValue({ server: { close: mocks.close }, url: 'http://127.0.0.1:12345/' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', original);
  vi.restoreAllMocks();
});
describe('offline spelling failures', () => {
  it('keeps app startup available with a local-only fallback and recovery notice', async () => {
    mocks.create.mockRejectedValue(new Error('missing index'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initializeOfflineSpellcheck } = await import('@/process/resources/offlineSpellcheck');
    await expect(initializeOfflineSpellcheck()).resolves.toBeUndefined();
    expect(mocks.setUrl).toHaveBeenCalledWith(expect.stringMatching(/^file:/));
    await vi.waitFor(() =>
      expect(mocks.show).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'preview.localSpellingUnavailableTitle',
          message: 'preview.localSpellingUnavailableDescription',
        })
      )
    );
  });
  it('warns once for failed dictionary requests without switching to an external feed', async () => {
    const { initializeOfflineSpellcheck } = await import('@/process/resources/offlineSpellcheck');
    await initializeOfflineSpellcheck();
    mocks.sessionHandlers.get('spellcheck-dictionary-download-failure')!();
    mocks.sessionHandlers.get('spellcheck-dictionary-download-failure')!();
    await vi.waitFor(() => expect(mocks.show).toHaveBeenCalledOnce());
    expect(mocks.setUrl).toHaveBeenLastCalledWith('http://127.0.0.1:12345/');
  });
  it('configures sessions created later with the same local dictionary endpoint', async () => {
    const { initializeOfflineSpellcheck } = await import('@/process/resources/offlineSpellcheck');
    await initializeOfflineSpellcheck();
    const later = { setSpellCheckerDictionaryDownloadURL: vi.fn(), on: vi.fn() };
    mocks.handlers.get('session-created')!(later);
    expect(later.setSpellCheckerDictionaryDownloadURL).toHaveBeenCalledWith('http://127.0.0.1:12345/');
  });
});
