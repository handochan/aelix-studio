import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { isolatedAppEnvironment } from './startup.mjs';

test('production startup does not inherit credentials, proxies or network-disable test guards', () => {
  const environment = isolatedAppEnvironment('/owned', {
    HOME: '/real/home',
    PATH: '/developer/tools',
    OPENAI_API_KEY: 'synthetic-key',
    SENTRY_DSN: 'synthetic-dsn',
    AELIX_AUTH_PATH: '/real/auth.json',
    HTTP_PROXY: 'http://proxy.invalid',
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    AIONUI_E2E_TEST: '1',
    AIONUI_DISABLE_AUTO_UPDATE: '1',
  });
  for (const key of [
    'OPENAI_API_KEY',
    'SENTRY_DSN',
    'HTTP_PROXY',
    'CI',
    'GITHUB_ACTIONS',
    'AIONUI_E2E_TEST',
    'AIONUI_DISABLE_AUTO_UPDATE',
  ]) {
    assert.equal(environment[key], undefined);
  }
  assert.equal(environment.HOME, path.join('/owned', 'home'));
  assert.equal(environment.AELIX_AUTH_PATH, path.join('/owned', 'agent', 'auth.json'));
});

test('preserves only the display transport and OS runtime required to launch an installed app', () => {
  const environment = isolatedAppEnvironment('/owned', {
    DISPLAY: ':99',
    XAUTHORITY: '/owned/xauth',
    SystemRoot: 'C:\\Windows',
    UNRELATED: 'ignored',
  });
  assert.equal(environment.DISPLAY, ':99');
  assert.equal(environment.XAUTHORITY, '/owned/xauth');
  assert.equal(environment.SystemRoot, 'C:\\Windows');
  assert.equal(environment.UNRELATED, undefined);
});

test('update measurement follows private and future sessions without creating a default session', async () => {
  const { installStartupUpdateProbe } = await import('./startupUpdates.mjs');
  const handlers = new Map();
  const callbacks = [];
  const createSession = () => ({ webRequest: { onBeforeRequest: (handler) => callbacks.push(handler) } });
  const existing = createSession();
  const api = {
    app: { on: (name, handler) => handlers.set(name, handler) },
    webContents: { getAllWebContents: () => [{ session: existing }] },
    dialog: {},
  };
  installStartupUpdateProbe(api);
  handlers.get('session-created')(createSession());
  handlers.get('web-contents-created')({}, { session: existing });
  assert.equal(callbacks.length, 2);
  let decision;
  callbacks[1]({ url: 'https://github.com/handochan/aelix-studio/releases.atom' }, (value) => {
    decision = value;
  });
  assert.deepEqual(decision, { cancel: true });
  assert.deepEqual(globalThis.__studioUpdateRequests, ['https://github.com/handochan/aelix-studio/releases.atom']);
});
