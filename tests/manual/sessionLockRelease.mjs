import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startStaticServer } from '../../packages/web-host/src/static-server.ts';

// Invoked by the host's smoke_session_release.py after a real native turn starts.
const [backendPort, conversationId] = process.argv.slice(2);
assert(backendPort && conversationId, 'Expected the fixture host port and conversation ID');
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
    assert((await registered).ok(), 'The mounted tab failed to register its view');
    await page.getByTestId('session-holder-send-box').waitFor({ state: 'attached' });
    await Promise.all([page.waitForEvent('close'), page.close({ runBeforeUnload: true })]);
  } finally {
    await browser.close();
  }
} finally {
  await web.stop();
}
