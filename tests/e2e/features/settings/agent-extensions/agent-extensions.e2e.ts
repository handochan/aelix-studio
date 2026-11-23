/**
 * Agent Extensions E2E Tests (Studio #32, 1b)
 *
 * Covers: the sidebar entry below Tools, the page with the Studio list (or the missing-runtime
 * notice where the runtime bundle is absent), the read-only terminal list, and the install
 * dialog's three sources. Nothing is installed: real installs are covered by the installed-app
 * smoke. All operations via UI.
 */

import { test, expect } from '../../../fixtures';
import { goToSettings, waitForSettle } from '../../../helpers/navigation';
import { takeScreenshot } from '../../../helpers/screenshots';
import { SETTINGS_SIDER_ITEM, settingsSiderItemById } from '../../../helpers/selectors';

test.describe('Agent Extensions', () => {
  test('TC-AEXT-01: sits below Tools in the AI core group and opens its page', async ({ page }) => {
    await goToSettings(page, 'tools');
    await waitForSettle(page);
    const ids = await page
      .locator(SETTINGS_SIDER_ITEM)
      .evaluateAll((items) => items.map((item) => item.getAttribute('data-settings-id')));
    // In the AI core group after Tools; a JS extension's tab anchored after Tools may come between.
    expect(ids.indexOf('agent-extensions')).toBeGreaterThan(ids.indexOf('tools'));
    expect(ids.indexOf('agent-extensions')).toBeLessThan(ids.indexOf('appearance'));

    await page.locator(settingsSiderItemById('agent-extensions')).first().click();
    await expect(page).toHaveURL(/#\/settings\/agent-extensions$/);
    await expect(page.getByTestId('agent-extensions-header')).toBeVisible();
    await takeScreenshot(page, 'agent-extensions/tc-aext-01/01-page.png');
  });

  test('TC-AEXT-02: shows the Studio list or the missing-runtime notice, and the terminal list', async ({ page }) => {
    await goToSettings(page, 'agentExtensions');
    await waitForSettle(page);
    const studio = page.locator(
      '[data-testid="agent-extensions-list"], [data-testid="agent-extensions-empty"], [data-testid="agent-extensions-runtime-unavailable"]'
    );
    await expect(studio.first()).toBeVisible({ timeout: 15_000 });
    const terminal = page.getByTestId('terminal-section');
    await expect(terminal).toBeVisible();
    // Folded under its summary line until opened.
    await terminal.locator('.arco-collapse-item-header').first().click();
    await expect(
      terminal.locator('[data-testid="terminal-environment"], [data-testid="terminal-none"]').first()
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('install-settings')).toBeVisible();
    // Let the section finish unfolding before the picture.
    await page.waitForTimeout(400);
    await takeScreenshot(page, 'agent-extensions/tc-aext-02/01-lists.png');
  });

  test('TC-AEXT-03: the install dialog offers a name, Git and a file', async ({ page }) => {
    await goToSettings(page, 'agentExtensions');
    await waitForSettle(page);
    const install = page.getByTestId('agent-extensions-install');
    await expect(install).toBeVisible({ timeout: 15_000 });
    if (await page.getByTestId('agent-extensions-runtime-unavailable').isVisible()) {
      await expect(install).toBeDisabled();
      test.skip(true, 'No Studio runtime bundle in this build: installs are off');
      return;
    }
    await install.click();
    const dialog = page.locator('.arco-modal').filter({ has: page.getByTestId('install-submit') });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.arco-tabs-header-title')).toHaveCount(3);
    await expect(page.getByTestId('install-submit')).toBeDisabled();
    await takeScreenshot(page, 'agent-extensions/tc-aext-03/01-dialog.png');
    await page.keyboard.press('Escape');
  });
});
