/**
 * E2E — file-type routing: unsupported formats, CSV, and Analytics HTML.
 *
 * Covers the two user-visible outcomes of routing types to renderers that can
 * actually open them:
 *
 *   1. **The escape hatch.** A format the panel cannot render must still leave the
 *      user a way to reach their own file. "Open in system app" is that way, and
 *      it is offered for two independent reasons whose order matters: the escape
 *      hatch is unconditional, the by-type convenience is not. A unit test can
 *      check that ordering in `shouldOfferOpenInSystem`; only this can show it
 *      survives the real toolbar, which renders that button from two separate
 *      blocks depending on whether the viewer injected extras.
 *
 *   2. **csv renders.** `.csv` used to be typed as `excel` and handed to
 *      officecli, which rejects CSV outright — so every csv failed in the
 *      renderer despite being plain text. The assertion here is that the content
 *      appears, not merely that nothing errored: "no error" and "rendered" are
 *      different claims, and only the second is the fix.
 *
 * Drives the real UI through the Explorer, the same entry point as
 * `preview-oversized-gate.e2e.ts`. Explorer-opened tabs carry no `file_path`,
 * which is exactly the case where the escape-hatch button used to disappear, so
 * this is the entry point worth testing.
 */
import fs from 'fs';
import { createServer } from 'node:http';
import os from 'os';
import path from 'path';
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';

/**
 * The hoisted preview region. Verified present in the source
 * (`Layout.tsx:550`) rather than guessed: a selector that does not exist yields
 * a falsy result that reads exactly like a broken feature.
 */
const PREVIEW_PANEL = '[data-project-preview-region]';

/** `preview.unsupported.title`, both shipped locales. */
const UNSUPPORTED_TITLE = /Preview not supported for this format|暂不支持预览此格式/;

/** `preview.openInSystemApp`, both shipped locales. */
const OPEN_IN_SYSTEM = /Open in system app|使用系统默认应用打开/;

type BackendWindow = Window & { __backendPort?: number };

/**
 * One representative per unsupported branch, because they are not equivalent:
 *
 *   - `.heic` is an image the renderer cannot decode.
 *   - `.doc` is legacy Office.
 *   - `.odt` is ODF.
 *   - `.docm` is macro-enabled Office — the interesting one, since officecli's
 *     factory claims to support it while its watch path refuses it. A type that
 *     looks supported one layer down is the most likely to slip back into a
 *     renderer that cannot open it.
 *
 * Covering one per branch rather than all ten keeps the run short while still
 * exercising each path; the full ten-extension mapping is asserted at the unit
 * layer (`tests/unit/previews/fileTypeMatrix.test.ts`).
 */
const UNSUPPORTED_SAMPLES = [
  { file: 'legacy.doc', label: 'DOC', why: 'legacy Office' },
  { file: 'opendoc.odt', label: 'ODT', why: 'ODF' },
  { file: 'macro.docm', label: 'DOCM', why: 'macro-enabled: officecli factory accepts, watch rejects' },
  { file: 'photo.heic', label: 'HEIC', why: 'image the renderer cannot decode' },
] as const;

/**
 * Bind a workspace as a project and route to its conversation.
 *
 * `type: 'acp'` with no assistant: the Explorer host only needs a published
 * `currentProject`, which the backend derives from `extra.workspace` on read. This
 * keeps the test independent of whether a usable assistant is configured, so a
 * missing agent cannot turn these into silent skips.
 */
async function createProjectConversation(page: import('@playwright/test').Page, workspace: string): Promise<string> {
  const conversationId = await page.evaluate(async (ws) => {
    const port = (window as BackendWindow).__backendPort;
    if (!port) throw new Error('window.__backendPort is not available — is aioncore running?');

    const created = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'acp',
        name: `E2E file types ${ws}`,
        extra: { workspace: ws, custom_workspace: true },
      }),
    });
    if (!created.ok) throw new Error(`POST /api/conversations failed (${created.status})`);
    const id = ((await created.json()) as { data?: { id?: string } })?.data?.id;
    if (!id) throw new Error('conversation create returned no id');

    // Read once so the backend performs the lazy project bind before we route.
    await fetch(`http://127.0.0.1:${port}/api/conversations/${id}`);
    return id;
  }, workspace);

  await page.evaluate((id) => window.location.assign(`#/conversation/${id}`), conversationId);
  await page.waitForFunction((id) => window.location.hash === `#/conversation/${id}`, conversationId, {
    timeout: 15_000,
  });

  // The Explorer tree mounting is the signal that `currentProject` was published.
  await expect(page.locator('.workspace-tree').first()).toBeVisible({ timeout: 30_000 });
  return conversationId;
}

async function deleteConversation(page: import('@playwright/test').Page, conversationId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const port = (window as BackendWindow).__backendPort;
    if (!port) return;
    await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
      () => {}
    );
  }, conversationId);
}

test.describe('Preview — file type routing', () => {
  let workspace: string;
  let conversationId: string | null = null;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-filetypes-'));
    // Contents are irrelevant: routing is by extension, and these formats are
    // never parsed. Small stubs keep the tree fast to load.
    for (const { file } of UNSUPPORTED_SAMPLES) {
      fs.writeFileSync(path.join(workspace, file), 'stub');
    }
    fs.writeFileSync(path.join(workspace, 'table.csv'), 'name,qty\nwidget,4\ngadget,7\n');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test.afterEach(async ({ page }) => {
    if (conversationId) {
      await deleteConversation(page, conversationId);
      conversationId = null;
    }
  });

  for (const sample of UNSUPPORTED_SAMPLES) {
    test(`${sample.file} is declined with an escape hatch (${sample.why})`, async ({ page }) => {
      test.setTimeout(120_000);
      await goToGuid(page);
      conversationId = await createProjectConversation(page, workspace);

      await page.getByText(sample.file, { exact: true }).first().click();

      const panel = page.locator(PREVIEW_PANEL);
      await expect(panel).toBeVisible({ timeout: 20_000 });

      // Told why, in terms of the format rather than a generic failure.
      await expect(page.getByText(UNSUPPORTED_TITLE).first()).toBeVisible({ timeout: 10_000 });
      await expect(panel).toContainText(sample.label);

      /**
       * The point of the whole test: the way out is present. An Explorer-opened
       * tab carries no `file_path`, so this button exists only because the
       * escape-hatch reason is checked before any type filtering.
       */
      await expect(panel.getByTitle(OPEN_IN_SYSTEM).first()).toBeVisible({ timeout: 10_000 });
    });
  }

  test('csv renders its contents as text', async ({ page }) => {
    /**
     * Asserts the cells are on screen. Checking only that no error appeared would
     * pass for a blank panel, which is the state this change exists to end.
     */
    test.setTimeout(120_000);
    await goToGuid(page);
    conversationId = await createProjectConversation(page, workspace);

    await page.getByText('table.csv', { exact: true }).first().click();

    const panel = page.locator(PREVIEW_PANEL);
    await expect(panel).toBeVisible({ timeout: 20_000 });

    // Content, not absence of an error.
    await expect(panel).toContainText('widget', { timeout: 20_000 });
    await expect(panel).toContainText('gadget');

    // And it must not have landed in the declined branch on the way.
    await expect(page.getByText(UNSUPPORTED_TITLE)).toHaveCount(0);
  });
});

test('Analytics Workspace preserves relative assets, navigation, and Report isolation', async ({
  page,
  electronApp,
}) => {
  test.setTimeout(120_000);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analytics-e2e-'));
  const workspace = path.join(parent, '분석 project');
  const revision = 'artifacts/reports/monthly/revision-a/content';
  const anotherRevision = 'artifacts/reports/monthly/revision-b/content';
  const files = {
    'analytics.json': '{"schema":"analytics.project/2"}',
    'workspace/index.html': [
      '<link rel="stylesheet" href="assets/main.css?v=1">',
      '<h1>Workspace entry</h1>',
      '<img src="../runs/sample/visualizations/plot.svg" alt="Plot">',
      '<a id="detail" href="nested/상세 페이지.html">Detail</a>',
      '<script defer src="assets/main.js"></script>',
    ].join(''),
    'workspace/assets/main.css': 'h1 { color: rgb(23, 45, 67) }',
    'workspace/assets/main.js': 'document.body.dataset.script = "workspace";',
    'workspace/nested/상세 페이지.html': [
      '<h1>Workspace detail</h1>',
      `<a id="report" href="../../${revision}/index.html" target="_blank" rel="noopener">Report</a>`,
    ].join(''),
    'runs/sample/visualizations/plot.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="7" height="8"><rect width="7" height="8"/></svg>',
    [`${revision}/index.html`]: '<h1>Original Report</h1><script src="./report.js"></script>',
    [`${revision}/report.js`]: 'document.body.dataset.script = "report";',
    [`${anotherRevision}/report.js`]: 'document.body.dataset.script = "other revision";',
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), contents);
  }
  let conversation: string | undefined;
  let externalRequests = 0;
  const otherOrigin = createServer((_request, response) => {
    externalRequests++;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end('fixture');
  });
  const preview = page.getByTestId('analytics-preview');
  const guest = (script: string): Promise<unknown> =>
    electronApp.evaluate(({ webContents }, code) => {
      const previewGuest = webContents
        .getAllWebContents()
        .find((candidate) => candidate.getURL().startsWith('studio-analytics://'));
      return previewGuest?.executeJavaScript(code, true);
    }, script);

  try {
    await new Promise<void>((resolve, reject) => {
      otherOrigin.once('error', reject);
      otherOrigin.listen(0, '127.0.0.1', resolve);
    });
    const address = otherOrigin.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
    await goToGuid(page);
    conversation = await createProjectConversation(page, workspace);
    const tree = page.locator('.workspace-tree').first();
    await tree.getByText('workspace', { exact: true }).click();
    await tree.getByText('index.html', { exact: true }).click();
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        guest(
          '[document.body?.dataset.script, document.querySelector("h1") && getComputedStyle(document.querySelector("h1")).color, document.images[0]?.naturalWidth]'
        )
      )
      .toEqual(['workspace', 'rgb(23, 45, 67)', 7]);
    const workspaceOrigin = await guest('location.origin');
    expect(workspaceOrigin).toMatch(/^studio-analytics:\/\/[0-9a-f]+$/);

    await guest('document.getElementById("detail").click()');
    await expect.poll(() => guest('document.querySelector("h1")?.textContent')).toBe('Workspace detail');
    await guest('document.getElementById("report").click()');
    await expect
      .poll(() =>
        guest('({ heading: document.querySelector("h1")?.textContent, script: document.body?.dataset.script })')
      )
      .toEqual({ heading: 'Original Report', script: 'report' });
    expect(await guest('location.origin')).not.toBe(workspaceOrigin);
    expect(await guest('[typeof window.electronAPI, window.opener === null]')).toEqual(['undefined', true]);

    const port = await page.evaluate(() => (window as BackendWindow).__backendPort);
    const checks = [
      'fetch("./report.js").then(r => r.status)',
      'fetch("../../revision-b/content/report.js").then(r => r.status)',
      `fetch("http://127.0.0.1:${port}/health").then(() => "reachable", () => "blocked")`,
      `fetch("http://127.0.0.1:${address.port}/asset").then(() => "reachable", () => "blocked")`,
    ];
    expect(await guest(`Promise.all([${checks.join(',')}])`)).toEqual([200, 404, 'blocked', 'blocked']);
    expect(externalRequests).toBe(0);
    await page
      .getByRole('button', { name: /^(Back|返回|뒤로)$/ })
      .filter({ visible: true })
      .last()
      .click();
    await expect.poll(() => guest('document.querySelector("h1")?.textContent')).toBe('Workspace detail');
  } finally {
    otherOrigin.close();
    if (conversation) await deleteConversation(page, conversation);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
