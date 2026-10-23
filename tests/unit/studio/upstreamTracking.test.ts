import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../../../scripts/aelix-studio/checkUpstream.mjs', import.meta.url));
const manifestPath = fileURLToPath(new URL('../../../docs/aelix-studio/upstream.json', import.meta.url));
type Manifest = {
  repository: string;
  upstream: {
    repository: string;
    tag: string;
    commit: string;
    history: { tag: string; commit: string; method: string; description: string }[];
  };
};
const readManifest = (): Manifest => JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
const run = (
  fixture: string,
  options: { manifest?: Manifest; release?: Record<string, unknown>; failOnDrift?: boolean } = {}
) => {
  const temporary = mkdtempSync(join(tmpdir(), 'studio-upstream-'));
  try {
    let releasePath = fileURLToPath(new URL(`./fixtures/${fixture}.json`, import.meta.url));
    if (options.release) {
      releasePath = join(temporary, 'release.json');
      writeFileSync(releasePath, JSON.stringify(options.release));
    }
    const args = [checker, '--release-file', releasePath];
    if (options.manifest) {
      const path = join(temporary, 'manifest.json');
      writeFileSync(path, JSON.stringify(options.manifest));
      args.push('--manifest-file', path);
    }
    if (options.failOnDrift) args.push('--fail-on-drift');
    return spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

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
  it('includes independently recorded source provenance in the report', () => {
    const report = JSON.parse(run('current').stdout);
    expect(report.studioRepository).toBe('handochan/aelix-studio');
    expect(report.upstreamRepository).toBe('iOfficeAI/AionUi');
    expect(report.adoptionHistory).toEqual(readManifest().upstream.history);
  });
  it('provides the pinned release and exact commit comparison for review', () => {
    const report = JSON.parse(run('new-release').stdout);
    expect(report.pinnedReleaseUrl).toBe('https://github.com/iOfficeAI/AionUi/releases/tag/v2.2.2');
    expect(report.compareUrl).toBe(
      'https://github.com/iOfficeAI/AionUi/compare/6744099b279b991c17e31c243f0920477bd31cb6...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
  });
  it('requires review if an existing release tag moves to a different commit', () => {
    const result = run('current', {
      failOnDrift: true,
      release: {
        tag_name: 'v2.2.2',
        html_url: 'https://github.com/iOfficeAI/AionUi/releases/tag/v2.2.2',
        commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).status).toBe('review_required');
  });
  it('fails explicitly when upstream metadata is incomplete', () => {
    const result = run('invalid');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe('error');
    expect(result.stderr).toContain('Missing or invalid release commit');
  });
  it('fails the opt-in CI gate when an upstream release needs review', () => {
    const result = run('new-release', { failOnDrift: true });
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).status).toBe('review_required');
  });
  it('rejects a pin update that omits its adoption history', () => {
    const manifest = readManifest();
    manifest.upstream.tag = 'v2.2.3';
    manifest.upstream.commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = run('new-release', { manifest });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).message).toContain('adoption history');
  });
  it('accepts a reviewed release with a matching appended adoption record', () => {
    const manifest = readManifest();
    manifest.upstream.tag = 'v2.2.3';
    manifest.upstream.commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    manifest.upstream.history.push({
      tag: manifest.upstream.tag,
      commit: manifest.upstream.commit,
      method: 'merge',
      description: 'Reviewed upstream release adoption.',
    });
    const result = run('new-release', { manifest });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('current');
  });
  it('rejects mutable branch names in the pinned commit', () => {
    const manifest = readManifest();
    manifest.upstream.commit = 'main';
    const result = run('current', { manifest });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing or invalid pinned upstream version');
  });
  it('rejects a release link from another repository', () => {
    const result = run('current', {
      release: {
        tag_name: 'v2.2.2',
        html_url: 'https://github.com/another/repository/releases/tag/v2.2.2',
        commit_sha: readManifest().upstream.commit,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Release URL does not match');
  });
  it.each(['draft', 'prerelease'])('rejects %s releases as a stable baseline', (field) => {
    const result = run('current', {
      release: {
        tag_name: 'v2.2.2',
        html_url: 'https://github.com/iOfficeAI/AionUi/releases/tag/v2.2.2',
        commit_sha: readManifest().upstream.commit,
        [field]: true,
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected a stable version tag');
  });
  it('leaves the adopted baseline unchanged when the drift gate fails', () => {
    const before = readFileSync(manifestPath, 'utf8');
    const result = run('new-release', { failOnDrift: true });
    expect(result.status).toBe(2);
    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });
});
