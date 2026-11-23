import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';

const testPackage = createRequire(import.meta.resolve('@playwright/test/package.json'));
const playwright = createRequire(testPackage.resolve('playwright/package.json'));
const core = createRequire(playwright.resolve('playwright-core/package.json'));
const { extract } = core('playwright-core/lib/zipBundle');

async function executableExists(file) {
  return fs.access(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK).then(
    () => true,
    () => false
  );
}

// The image probe does not use Playwright's video recorder. The browser can
// already be present if the installer failed while fetching another tool.
const installed = chromium.executablePath();
spawnSync(process.execPath, [testPackage.resolve('./cli.js'), 'install', 'chromium', '--no-shell'], {
  stdio: 'ignore',
  timeout: 180000,
});
if (await executableExists(installed)) {
  process.stdout.write(installed);
} else {
  // Use the same browser revision, with the original archive as an alternate
  // source in case the Playwright installer or CDN cannot deliver it.
  const { browserVersion, revision } = core('./browsers.json').browsers.find(({ name }) => name === 'chromium');
  const platform = process.platform + '-' + process.arch;
  const archive = {
    'linux-x64': {
      url: `https://storage.googleapis.com/chrome-for-testing-public/${browserVersion}/linux64/chrome-linux64.zip`,
      entry: 'chrome-linux64/chrome',
    },
    'win32-x64': {
      url: `https://storage.googleapis.com/chrome-for-testing-public/${browserVersion}/win64/chrome-win64.zip`,
      entry: 'chrome-win64/chrome.exe',
    },
    'linux-arm64': {
      url: `https://playwright.download.prss.microsoft.com/dbazure/download/playwright/builds/chromium/${revision}/chromium-linux-arm64.zip`,
      entry: 'chrome-linux/chrome',
    },
  }[platform];
  assert.ok(archive, 'No alternate browser archive for this target');
  await fs.mkdir('.local', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.local', 'image-chromium-'));
  const zip = path.join(dir, 'browser.zip');
  try {
    const download = spawnSync(
      'curl',
      ['--fail', '--location', '--silent', '--retry', '2', '--max-time', '120', '--output', zip, archive.url],
      { stdio: 'ignore', timeout: 260000 }
    );
    assert.equal(download.status, 0);
    await extract(zip, { dir });
  } finally {
    await fs.rm(zip, { force: true });
  }
  const executable = path.join(dir, archive.entry);
  if (process.platform !== 'win32') await fs.chmod(executable, 0o755);
  assert.ok(await executableExists(executable));
  process.stdout.write(executable);
}
