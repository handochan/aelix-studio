import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../../../scripts/aelix-studio/checkUpstream.mjs', import.meta.url));
const run = (fixture: string) =>
  spawnSync(
    process.execPath,
    [checker, '--release-file', fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url))],
    { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }
  );

describe('read-only upstream release tracking', () => {
  it('reports an unchanged stable tag and commit without proposing an update', () => {
    const result = run('current');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('current');
  });
  it('requires review when a new stable release differs from the pinned baseline', () => {
    const result = run('new-release');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('review_required');
  });
  it('fails explicitly when upstream metadata is incomplete', () => {
    const result = run('invalid');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing or invalid release commit');
  });
});
