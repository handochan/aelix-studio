import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { prepareAioncore, getAssetName } = require('../../../packages/shared-scripts/src/prepare-aioncore');
const { policy } = require('../../../packages/shared-scripts/src/default-host');

describe('pinned host preparation admission', () => {
  it.each([undefined, {}, { aioncoreSourcePolicy: 'unknown.json' }])(
    'refuses an absent or unknown release policy',
    (config) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'studio-policy-'));
      try {
        if (config) writeFileSync(join(projectRoot, 'package.json'), JSON.stringify(config));
        expect(() =>
          prepareAioncore({ projectRoot, platform: process.platform, arch: process.arch, version: 'latest' })
        ).toThrow(/policy/);
        expect(existsSync(join(projectRoot, 'resources'))).toBe(false);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  );
  it.each(['latest', 'v0.2.2', '0.2.2', 'host-v0.2.2-aelix.999'])('refuses an unpinned version %s', (version) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'studio-policy-'));
    try {
      writeFileSync(
        join(projectRoot, 'package.json'),
        JSON.stringify({ aioncoreSourcePolicy: 'scripts/studio-preview/host-release/default.json' })
      );
      expect(() => prepareAioncore({ projectRoot, platform: process.platform, arch: process.arch, version })).toThrow(
        'Host version differs from the pinned release'
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
  it('returns only declared pinned archive names', () => {
    expect(getAssetName('win32', 'x64', policy.tag)).toBe(policy.targets['win32-x64'].archive);
    expect(() => getAssetName('win32', 'x64', 'v0.2.2')).toThrow('pinned release');
  });
});
