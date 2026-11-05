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
});
