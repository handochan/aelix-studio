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
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';
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
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');

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

test('ordinary HTML and SVG open below folders named workspace and reports', async ({ page }) => {
  test.setTimeout(120_000);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-ordinary-preview-'));
  const directory = path.join(parent, 'workspace', 'reports', 'quarterly', 'site');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(parent, 'journal.jsonl'), '{"schema":"other.event/1","text":"Unrelated journal"}\n');
  fs.writeFileSync(path.join(directory, 'index.html'), '<h1>Ordinary HTML</h1>');
  fs.writeFileSync(
    path.join(directory, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>Ordinary SVG</title></svg>'
  );
  let conversation: string | undefined;
  try {
    await goToGuid(page);
    conversation = await createProjectConversation(page, directory);
    const tree = page.locator('.workspace-tree').first();
    const panel = page.locator(PREVIEW_PANEL);
    await tree.getByText('index.html', { exact: true }).click();
    await expect(panel.locator('webview')).toBeVisible();
    await expect(panel.getByTestId('analytics-preview')).toHaveCount(0);
    await tree.getByText('logo.svg', { exact: true }).click();
    await expect(panel.getByRole('img', { name: 'logo.svg' })).toBeVisible();
  } finally {
    if (conversation) await deleteConversation(page, conversation);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('unclassified HTML and SVG show inert source with no guest grant', async ({ page }) => {
  test.setTimeout(120_000);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inert-source-'));
  const content = path.join(parent, 'artifacts', 'reports', 'monthly', 'build', 'content');
  fs.mkdirSync(content, { recursive: true });
  fs.writeFileSync(
    path.join(parent, 'journal.jsonl'),
    ('{"schema":"other.event/1","text":"' + 'a'.repeat(1024) + '"}\n').repeat(512)
  );
  const documents = {
    'index.html': '<h1>Report</h1><script>document.title = "executed";</script><a href="about:blank">Link</a>',
    'chart.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "executed";</script></svg>',
  };
  for (const [name, source] of Object.entries(documents)) fs.writeFileSync(path.join(content, name), source);
  let conversation: string | undefined;
  try {
    await goToGuid(page);
    conversation = await createProjectConversation(page, content);
    const panel = page.locator(PREVIEW_PANEL);
    const source = panel.getByTestId('preview-inert-source');
    for (const [name, markup] of Object.entries(documents)) {
      await page.locator('.workspace-tree').first().getByText(name, { exact: true }).click();
      await expect(source).toHaveText(markup);
      await expect(source.locator('script, svg, a, img')).toHaveCount(0);
      await expect(panel.locator('webview, iframe')).toHaveCount(0);
    }
    const opened = await page.evaluate(async (id) => {
      const base = `http://127.0.0.1:${(window as BackendWindow).__backendPort}`;
      const { data: conversation } = await (await fetch(`${base}/api/conversations/${id}`)).json();
      const { data: project } = await (await fetch(`${base}/api/projects/${conversation.project_id}`)).json();
      return window.electronAPI!.analyticsPreview!.open({
        projectId: project.project_id,
        file: { kind: 'project', pe_id: project.explorer.workspace_pe_id, relative_path: 'index.html' },
      });
    }, conversation);
    expect(opened).toBeNull();
  } finally {
    if (conversation) await deleteConversation(page, conversation);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('Explorer refuses a markerless prepared Report opened from its content folder', async ({ page }) => {
  test.setTimeout(120_000);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-prepared-report-'));
  const stage = path.join(parent, 'artifacts', 'reports', 'monthly', '.staging', 'revision-a');
  const content = path.join(stage, 'content');
  fs.mkdirSync(content, { recursive: true });
  fs.writeFileSync(path.join(content, 'prepared.html'), '<h1>Prepared Report</h1>');
  fs.writeFileSync(
    path.join(parent, 'journal.jsonl'),
    ('{"schema":"other.event/1","text":"' + 'a'.repeat(1024) + '"}\n').repeat(512) +
      [
        '{"schema":"lab.event/1","id":"e1","seq":1,"kind":"project","refs":{}}',
        '{"schema":"analytics.event/2","id":"e2","seq":2,"kind":"context","refs":[]}',
        '',
      ].join('\n')
  );
  fs.writeFileSync(
    path.join(stage, 'manifest.json'),
    '{"schema":"analytics.report_revision/1","report_id":"monthly","revision_id":"revision-a","entry":"prepared.html"}'
  );
  let conversation: string | undefined;
  try {
    await goToGuid(page);
    conversation = await createProjectConversation(page, content);
    await page.locator('.workspace-tree').first().getByText('prepared.html', { exact: true }).click();
    await expect(page.getByText(/^(Failed to preview|预览失败|미리보기 실패)$/)).toBeVisible();
    await expect(page.locator(PREVIEW_PANEL).locator('webview')).toHaveCount(0);
  } finally {
    if (conversation) await deleteConversation(page, conversation);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('Analytics Workspace preserves relative assets, navigation, and Report isolation', async ({
  page,
  electronApp,
}) => {
  test.setTimeout(120_000);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analytics-e2e-'));
  const workspace = path.join(parent, 'workspace', '분석 project');
  fs.writeFileSync(path.join(parent, 'analytics.json'), '{"schema":"ordinary.project/1","enabled":true}');
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
    'ordinary.txt': 'Switch to this file and back.',
    'workspace/reports/monthly-stem/revision-a/files/copy.html': '<script>document.title = "copy";</script>',
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
  const manifest = JSON.stringify({
    schema: 'analytics.report_revision/1',
    report_id: 'monthly',
    revision_id: 'revision-a',
    request_id: 'req-fixture',
    previous_revision: null,
    entry: 'index.html',
    files: Object.entries(files).flatMap(([name, value]) =>
      name.startsWith(revision + '/')
        ? [{ path: name.slice(revision.length + 1), bytes: Buffer.byteLength(value), sha256: sha256(value) }]
        : []
    ),
  });
  Object.assign(files, {
    'artifacts/reports/monthly/revision-a/manifest.json': manifest,
    'journal.jsonl':
      JSON.stringify({
        schema: 'analytics.event/2',
        kind: 'report_revision',
        id: 'e1',
        seq: 1,
        request_id: 'req-fixture',
        details: { previous_revision: null },
        refs: [
          {
            type: 'report_revision',
            report_id: 'monthly',
            revision_id: 'revision-a',
            relation: 'about',
            basis: 'observed',
            version_binding: 'author',
            digest: { sha256: sha256(manifest) },
          },
        ],
      }) + '\n',
  });
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
    fs.writeFileSync(path.join(workspace, name), contents);
  }
  const journal = path.join(workspace, 'journal.jsonl');
  const timeline =
    Array.from({ length: 2100 }, (_, index) =>
      JSON.stringify({
        schema: 'analytics.event/2',
        kind: 'note',
        id: `e${index + 2}`,
        seq: index + 2,
        text: 'a'.repeat(8250),
      })
    ).join('\n') + '\n';
  fs.appendFileSync(journal, timeline);
  const journalSize = fs.statSync(journal).size;
  expect(journalSize).toBeGreaterThan(16 * 1024 * 1024);
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

    await tree.getByText('ordinary.txt', { exact: true }).click();
    await expect(preview).toBeHidden();
    await page.locator(PREVIEW_PANEL).getByTitle('index.html', { exact: true }).click();
    await expect(preview).toBeVisible();
    expect(await guest('document.body?.dataset.script')).toBe('report');

    const port = await page.evaluate(() => (window as BackendWindow).__backendPort);
    const checks = [
      'fetch("./report.js").then(r => r.status)',
      'fetch("../../revision-b/content/report.js").then(r => r.status)',
      `fetch("http://127.0.0.1:${port}/health").then(() => "reachable", () => "blocked")`,
      `fetch("http://127.0.0.1:${address.port}/asset").then(() => "reachable", () => "blocked")`,
    ];
    expect(await guest(`Promise.all([${checks.join(',')}])`)).toEqual([200, 404, 'blocked', 'blocked']);
    expect(externalRequests).toBe(0);
    fs.writeFileSync(path.join(workspace, revision, 'added.js'), 'void 0');
    fs.writeFileSync(path.join(workspace, revision, 'report.js'), 'void 1');
    expect(await guest('Promise.all(["added.js", "report.js"].map(file => fetch(file).then(r => r.status)))')).toEqual([
      404, 409,
    ]);
    await page
      .getByRole('button', { name: /^(Back|返回|뒤로)$/ })
      .filter({ visible: true })
      .last()
      .click();
    await expect.poll(() => guest('document.querySelector("h1")?.textContent')).toBe('Workspace detail');
    expect(await guest('fetch("/workspace/reports/monthly-stem/revision-a/files/copy.html").then(r => r.status)')).toBe(
      404
    );

    const detached = path.join(parent, 'Empty workspace');
    fs.mkdirSync(detached);
    await deleteConversation(page, conversation);
    conversation = await createProjectConversation(page, detached);
    const projectId = await page.evaluate(async (id: string) => {
      const port = (window as BackendWindow).__backendPort;
      const response = await fetch(`http://127.0.0.1:${port}/api/conversations/${id}`);
      return ((await response.json()) as { data: { project_id: string } }).data.project_id;
    }, conversation);
    const peId = await page.evaluate(
      async ({ projectId, uri }) => {
        const port = (window as BackendWindow).__backendPort;
        const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/folders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri, display_name: 'Original Report content' }),
        });
        if (!response.ok) throw new Error(`Attaching Report content failed (${response.status})`);
        return ((await response.json()) as { data: { pe_id: string } }).data.pe_id;
      },
      { projectId, uri: pathToFileURL(path.join(workspace, revision)).href }
    );
    fs.appendFileSync(journal, '{"schema":"future","kind":"other","id":"conflict","seq":1}\n');
    const conflicted = await page.evaluate(
      ({ projectId, peId }) =>
        window.electronAPI!.analyticsPreview!.open({
          projectId,
          file: { kind: 'project', pe_id: peId, relative_path: 'index.html' },
        }),
      { projectId, peId }
    );
    expect(conflicted).toBeNull();
    fs.truncateSync(journal, journalSize);
    const match = await page.evaluate(
      async ({ projectId, peId }) => {
        const bridge = window.electronAPI!.analyticsPreview!;
        const file = { kind: 'project' as const, pe_id: peId, relative_path: 'index.html' };
        const recognized = await bridge.classify({ projectId, file });
        const opened = await bridge.open({ projectId, file });
        if (!opened) throw new Error('The nested Report failed to open');
        const guest = document.createElement('webview');
        guest.setAttribute('partition', opened.partition);
        guest.setAttribute('src', opened.url);
        guest.id = 'attached-report-probe';
        document.body.append(guest);
        return recognized;
      },
      { projectId, peId }
    );
    expect(match).toBe('isolated');
    await expect.poll(() => guest('document.querySelector("h1")?.textContent')).toBe('Original Report');
    await page.evaluate(({ projectId, peId }) => window.electronAPI!.analyticsPreview!.detach(projectId, peId), {
      projectId,
      peId,
    });
    await expect.poll(() => guest('location.href')).toBeUndefined();
    await page.locator('#attached-report-probe').evaluate((element) => element.remove());
  } finally {
    otherOrigin.close();
    if (conversation) await deleteConversation(page, conversation);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('opens 0.32.1 kit-generated HTML and SVG original links in isolated revisions', async ({ page, electronApp }) => {
  const workspace = process.env.STUDIO10_KIT_FIXTURE;
  test.skip(!workspace, 'Set STUDIO10_KIT_FIXTURE to the generated Analytics test project');
  if (!workspace) return;
  test.setTimeout(120_000);
  let conversation: string | undefined;
  const guest = async (script: string): Promise<unknown> => {
    const id = await page
      .getByTestId('analytics-preview')
      .filter({ visible: true })
      .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId())
      .catch(() => undefined);
    if (id === undefined) return;
    return electronApp.evaluate(
      ({ webContents }, { id, script }) => webContents.fromId(id)?.executeJavaScript(script, true),
      {
        id,
        script,
      }
    );
  };

  try {
    await goToGuid(page);
    conversation = await createProjectConversation(page, workspace);
    const tree = page.locator('.workspace-tree').first();
    await tree.getByText('workspace', { exact: true }).click();
    await tree.getByText('reports', { exact: true }).click();

    const html = fs.readdirSync(path.join(workspace, 'workspace/reports')).find((name) => /^html-.*\.html$/.test(name));
    const svg = fs.readdirSync(path.join(workspace, 'workspace/reports')).find((name) => /^svg-.*\.html$/.test(name));
    const markdown = fs
      .readdirSync(path.join(workspace, 'workspace/reports'), { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('markdown-'));
    if (!markdown) throw new Error('Expected generated Markdown view files');
    const revision = fs.readdirSync(path.join(workspace, 'workspace/reports', markdown.name))[0];
    const copy = `workspace/reports/${markdown.name}/${revision}/files/copy.html`;
    expect(fs.existsSync(path.join(workspace, copy))).toBe(true);
    const blocked = await page.evaluate(
      async ({ id, copy }) => {
        const base = `http://127.0.0.1:${(window as BackendWindow).__backendPort}`;
        const { data: conversation } = await (await fetch(`${base}/api/conversations/${id}`)).json();
        const { data: project } = await (await fetch(`${base}/api/projects/${conversation.project_id}`)).json();
        return window
          .electronAPI!.analyticsPreview!.classify({
            projectId: project.project_id,
            file: { kind: 'project', pe_id: project.explorer.workspace_pe_id, relative_path: copy },
          })
          .then(
            () => false,
            () => true
          );
      },
      { id: conversation, copy }
    );
    expect(blocked).toBe(true);
    if (!html || !svg) throw new Error('Expected generated kit Report pages');
    await tree.getByText(html, { exact: true }).click();
    await expect
      .poll(() => guest('!!document.querySelector("a[target=_blank][href$=\\"/content/index.html\\"]")'))
      .toBe(true);
    await guest('document.querySelector("a[target=_blank][href$=\\"/content/index.html\\"]").click()');
    await expect.poll(() => guest('document.body?.dataset.saved')).toBe('yes');

    await tree.getByText(svg, { exact: true }).click();
    const svgLink = 'a[target=_blank][href$="/content/entry.svg"]';
    await expect.poll(() => guest(`!!document.querySelector(${JSON.stringify(svgLink)})`)).toBe(true);
    await guest(`document.querySelector(${JSON.stringify(svgLink)}).click()`);
    await expect.poll(() => guest('document.querySelector("svg title")?.textContent')).toBe('Kit SVG original');
  } finally {
    if (conversation) await deleteConversation(page, conversation);
  }
});

test('0.26.0 kit-generated download link saves only the verified original after Save As', async ({
  page,
  electronApp,
}) => {
  const workspace = process.env.STUDIO10_LEGACY_KIT_FIXTURE;
  test.skip(!workspace, 'Set STUDIO10_LEGACY_KIT_FIXTURE to the generated legacy Analytics test project');
  if (!workspace) return;
  test.setTimeout(120_000);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analytics-download-'));
  const destination = path.join(scratch, 'saved.html');
  let conversation: string | undefined;

  try {
    await goToGuid(page);
    conversation = await createProjectConversation(page, workspace);
    const tree = page.locator('.workspace-tree').first();
    await tree.getByText('workspace', { exact: true }).click();
    await tree.getByText('reports', { exact: true }).click();
    const report = fs
      .readdirSync(path.join(workspace, 'workspace/reports'))
      .find((name) => /^html-.*\.html$/.test(name));
    if (!report) throw new Error('Expected a kit-generated legacy Report page');
    await tree.getByText(report, { exact: true }).click();
    const webview = page.getByTestId('analytics-preview').filter({ visible: true });
    await expect(webview).toBeVisible();
    await electronApp.evaluate(({ dialog }, filePath) => {
      const original = dialog.showSaveDialog;
      dialog.showSaveDialog = async () => {
        dialog.showSaveDialog = original;
        return { canceled: false, filePath };
      };
    }, destination);
    const id = await webview.evaluate((element) => (element as Electron.WebviewTag).getWebContentsId());
    const inspect = (code: string): Promise<unknown> =>
      electronApp.evaluate(({ webContents }, { id, code }) => webContents.fromId(id)?.executeJavaScript(code, true), {
        id,
        code,
      });
    const download = 'a[download][href$="/content/index.html"]';
    await expect.poll(() => inspect(`!!document.querySelector(${JSON.stringify(download)})`)).toBe(true);
    await inspect(`document.querySelector(${JSON.stringify(download)}).click()`);
    await expect.poll(() => fs.existsSync(destination)).toBe(true);
    const reportRoot = path.join(workspace, 'artifacts/reports/html');
    const revision = fs.readdirSync(reportRoot).find((name) => !name.startsWith('.'));
    if (!revision) throw new Error('Expected a saved Report revision');
    expect(fs.readFileSync(destination)).toEqual(
      fs.readFileSync(path.join(reportRoot, revision, 'content/index.html'))
    );
    expect(await inspect('location.pathname')).toContain('/workspace/reports/');
  } finally {
    if (conversation) await deleteConversation(page, conversation);
    fs.rmSync(scratch, { force: true, recursive: true });
  }
});
