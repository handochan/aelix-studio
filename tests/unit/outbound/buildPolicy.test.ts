import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
describe('telemetry-free release preparation', () => {
  it('has no Sentry build steps, secrets or dependencies', () => {
    for (const name of ['package.json', 'bun.lock', '.github/workflows/_build-reusable.yml']) {
      expect(readFileSync(path.join(root, name), 'utf8')).not.toMatch(
        /@sentry\/|SENTRY_(?:DSN|AUTH_TOKEN|RELEASE|UPLOAD_SOURCE_MAPS)/
      );
    }
  });

  it('does not start crash reporting or collect console breadcrumbs in desktop entry points', () => {
    for (const name of [
      'packages/desktop/electron.vite.config.ts',
      'packages/desktop/src/index.ts',
      'packages/desktop/src/preload/main.ts',
      'packages/desktop/src/renderer/main.tsx',
    ]) {
      expect(readFileSync(path.join(root, name), 'utf8'), name).not.toMatch(
        /@sentry\/|\bbeforeBreadcrumb\b|\bcrashReporter\b/
      );
    }
  });
});
