import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startStaticServer } from '../../packages/web-host/src/static-server.ts';

// Invoked by the host's smoke_session_release.py after a real native turn starts.
const [backendPort, conversationId] = process.argv.slice(2);
assert(backendPort && conversationId, 'Expected the fixture host port and conversation ID');
const sessionRoute = `/api/conversations/${conversationId}`;
const ensurePath = `${sessionRoute}/runtime/ensure`;
const renewPath = `${sessionRoute}/active-lease`;
const releasePath = `${sessionRoute}/runtime/release`;
const refreshPath = '/api/auth/refresh';

function responseAt(page, path, status) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === path &&
      (status === undefined || status === response.status()),
    { timeout: 15_000 }
  );
}

async function expireFixtureAccess(context, origin) {
  const secret = process.env.STUDIO_RELEASE_FIXTURE_JWT;
  assert(secret, 'The retry regression requires a disposable protected host fixture');
  const cookie = (await context.cookies(origin)).find(({ name }) => name === 'aionui-session');
  assert(cookie, 'The test browser is missing its fixture access cookie');
  const [header, payload] = cookie.value.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.exp = claims.iat - 120;
  const expired = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const signature = createHmac('sha256', secret).update(expired).digest('base64url');
  await context.addCookies([{ ...cookie, value: `${expired}.${signature}` }]);
}

async function verifyLatePreparation(page, context, origin, viewId) {
  const lifecyclePaths = new Set([ensurePath, renewPath, releasePath, refreshPath]);
  // Keep other startup reads from refreshing cookies ahead of the request under test.
  await page.route('**/api/**', (route) =>
    lifecyclePaths.has(new URL(route.request().url()).pathname) ? route.continue() : route.abort()
  );
  await expireFixtureAccess(context, origin);
  const renewalRejected = responseAt(page, renewPath, 401);
  const renewed = responseAt(page, renewPath, 200);
  const renewalRefresh = responseAt(page, refreshPath, 200);
  const visibilityChanged = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await visibilityChanged();
  await Promise.all([renewalRejected, renewalRefresh, renewed]);

  // The paused ensure is an actual view recovery launched by a lease 409.
  // Deliver it only after the SPA navigates away and the host releases the writer.
  await page.route(`**${renewPath}`, (route) => route.fulfill({ status: 409, json: { code: 'CONFLICT' } }), {
    times: 1,
  });
  let seePreparation;
  const preparationStarted = new Promise((resolve) => {
    seePreparation = resolve;
  });
  await page.route(
    (url) => url.pathname === ensurePath,
    async (route) => {
      seePreparation(new URL(route.request().url()));
      await route.abort();
    },
    { times: 1 }
  );
  await visibilityChanged();
  const delayed = await preparationStarted;
  assert.equal(delayed.searchParams.get('view_id'), viewId);

  await expireFixtureAccess(context, origin);
  const departureRejected = responseAt(page, releasePath, 401);
  const departureRefresh = responseAt(page, refreshPath, 200);
  const released = responseAt(page, releasePath, 200);
  await page.evaluate(() => {
    window.location.hash = '/guid';
  });
  await Promise.all([departureRejected, departureRefresh]);
  assert.equal((await (await released).json()).data.outcome, 'released');

  // Deliver the captured request independently, even though the renderer
  // cancelled it when leaving. The host must still fence the old view.
  const stale = await context.request.post(delayed.href, {
    headers: { origin, 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(stale.status(), 409);
}

const web = await startStaticServer({
  staticDir: fileURLToPath(new URL('../../out/renderer/', import.meta.url)),
  backendPort: Number(backendPort),
  port: 0,
});
try {
  const browser = await chromium.launch({ executablePath: process.env.STUDIO_RELEASE_CHROMIUM });
  try {
    const context = await browser.newContext();
    const login = await context.request.post(web.localUrl + '/login', {
      headers: { origin: web.localUrl, 'sec-fetch-site': 'same-origin' },
      data: { username: process.env.STUDIO_RELEASE_USER, password: process.env.STUDIO_RELEASE_PASSWORD },
    });
    assert(login.ok(), 'Fixture browser login failed');
    const page = await context.newPage();
    const requestedViews = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === ensurePath) {
        requestedViews.push(url.searchParams.get('view_id'));
      }
    });
    const registered = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === 'POST' &&
          url.pathname === `/api/conversations/${conversationId}/runtime/ensure` &&
          url.searchParams.has('view_id')
        );
      },
      { timeout: 25_000 }
    );
    await page.goto(`${web.localUrl}/#/conversation/${conversationId}`);
    const registration = await registered;
    assert(registration.ok(), 'The mounted tab failed to register its view');
    const viewId = new URL(registration.url()).searchParams.get('view_id');
    await page.getByTestId('session-holder-send-box').waitFor({ state: 'attached' });
    if (process.env.STUDIO_RELEASE_SCENARIO === 'late-spa') {
      await verifyLatePreparation(page, context, web.localUrl, viewId);
    } else {
      await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
    }
    assert(requestedViews.length > 0 && requestedViews.every((id) => id === viewId));
  } finally {
    await browser.close();
  }
} finally {
  await web.stop();
}
