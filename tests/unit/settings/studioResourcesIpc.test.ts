import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initAllBridges, registerNativeAuthWindow } from '@process/bridge';
import fixture from '../../../packages/web-host/src/studio-auth/resources/studio-7-d16-v1.json';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  handle: vi.fn(),
  fromWebContents: vi.fn(),
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { once: vi.fn() },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  ipcMain: { handle: mocks.handle },
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, sendSync: vi.fn(), on: vi.fn() },
  webUtils: {},
}));
vi.mock('@aionui/web-host', () => ({
  getNativeAuthService: () => ({ cancelOwner: vi.fn(), dispose: vi.fn() }),
  getNativeResourcesService: () => ({ request: mocks.request, dispose: vi.fn() }),
}));
vi.mock('@process/bridge/applicationBridge', () => ({ initApplicationBridge: vi.fn() }));
vi.mock('@process/bridge/dialogBridge', () => ({ initDialogBridge: vi.fn() }));
vi.mock('@process/bridge/updateBridge', () => ({ initUpdateBridge: vi.fn() }));
vi.mock('@process/bridge/systemSettingsBridge', () => ({ initSystemSettingsBridge: vi.fn() }));
vi.mock('@process/bridge/windowControlsBridge', () => ({
  initWindowControlsBridge: vi.fn(),
  registerWindowMaximizeListeners: vi.fn(),
}));
vi.mock('@process/bridge/notificationBridge', () => ({ initNotificationBridge: vi.fn() }));
vi.mock('@process/bridge/webuiBridge', () => ({ initWebuiBridge: vi.fn() }));
vi.mock('@process/bridge/themeBridge', () => ({ initThemeBridge: vi.fn() }));
vi.mock('@process/backend/studioRequest', () => ({ protectStudioRequests: vi.fn() }));
vi.mock('@process/services/StudioExtensionsService', () => ({
  cancelStudioExtensionsOf: vi.fn(),
  studioExtensionsIpcHandler: vi.fn(),
}));

const fixtureChannel = fixture.find(({ id }) => id === 'helper-envelope')!.desktop!;
const refusal = fixture.find(({ id }) => id === 'helper-error-forbidden')!.reply;

describe('native resources desktop IPC', () => {
  const mainFrame = {};
  const validUrl = 'file:///app/renderer/index.html';
  const sender = { id: 81, mainFrame, getURL: vi.fn(), on: vi.fn(), once: vi.fn() };
  const event = (senderFrame: unknown = mainFrame, id = sender.id) =>
    ({ sender: { ...sender, id }, senderFrame }) as unknown as IpcMainInvokeEvent;
  const dispatch = () => mocks.handle.mock.calls.find(([channel]) => channel === fixtureChannel.ipc)![1];

  beforeEach(() => {
    vi.clearAllMocks();
    sender.getURL.mockReturnValue(validUrl + '#settings');
    mocks.fromWebContents.mockReturnValue({});
    registerNativeAuthWindow({ webContents: sender } as unknown as BrowserWindow, [validUrl]);
    initAllBridges();
  });

  it('exposes the fixture method through the dedicated preload channel', async () => {
    await import('../../../packages/desktop/src/preload/main');
    const [bridge, method] = fixtureChannel.bridge.split('.');
    const api = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === bridge)![1];
    api[method](...fixtureChannel.args);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(fixtureChannel.ipc, ...fixtureChannel.args);
  });

  it('passes trusted main-frame commands to the shared service under the window identity', async () => {
    const reply = fixture.find(({ id }) => id === 'helper-skills')!.reply;
    mocks.request.mockResolvedValue(reply);
    expect(await dispatch()(event(), ...fixtureChannel.args)).toEqual(reply);
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith('desktop:81', ...fixtureChannel.args);
  });

  it.each(['unregistered', 'subframe', 'navigated', 'invalid URL', 'destroyed window'])(
    'refuses a %s sender before dispatch',
    (reason) => {
      if (reason === 'navigated') sender.getURL.mockReturnValue('https://other.example');
      if (reason === 'invalid URL') sender.getURL.mockReturnValue('');
      if (reason === 'destroyed window') mocks.fromWebContents.mockReturnValue(null);
      const source = event(reason === 'subframe' ? {} : mainFrame, reason === 'unregistered' ? 82 : 81);
      expect(dispatch()(source, ...fixtureChannel.args)).toEqual(refusal);
      expect(mocks.request).not.toHaveBeenCalled();
    }
  );
});
