/** Aelix Studio modification: report independent source provenance and reviewed upstream adoptions. */
import { appendFileSync, readFileSync } from 'node:fs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

async function github(repository, path) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}`);
  return response.json();
}

try {
  const failOnDrift = process.argv.includes('--fail-on-drift');
  const args = process.argv.slice(2).filter((arg) => arg !== '--fail-on-drift');
  const paths = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    if (!['--release-file', '--manifest-file'].includes(option) || !args[index + 1] || paths.has(option)) {
      throw new Error('Usage: checkUpstream.mjs [--release-file PATH] [--manifest-file PATH] [--fail-on-drift]');
    }
    paths.set(option, args[index + 1]);
  }
  const manifest = JSON.parse(
    readFileSync(
      paths.get('--manifest-file') ?? new URL('../../docs/aelix-studio/upstream.json', import.meta.url),
      'utf8'
    )
  );
  const repository = manifest.upstream?.repository;
  if (!REPOSITORY_PATTERN.test(repository ?? '')) throw new Error('Invalid upstream repository');
  if (!REPOSITORY_PATTERN.test(manifest.repository ?? '')) throw new Error('Invalid Studio repository');
  if (!TAG_PATTERN.test(manifest.upstream.tag ?? '') || !COMMIT_PATTERN.test(manifest.upstream.commit ?? '')) {
    throw new Error('Missing or invalid pinned upstream version');
  }
  const history = manifest.upstream.history;
  if (
    !Array.isArray(history) ||
    history.length === 0 ||
    history.some(
      (entry) =>
        !TAG_PATTERN.test(entry?.tag ?? '') ||
        !COMMIT_PATTERN.test(entry?.commit ?? '') ||
        !['baseline', 'merge'].includes(entry?.method) ||
        typeof entry?.description !== 'string' ||
        entry.description.trim().length === 0
    ) ||
    history[history.length - 1].tag !== manifest.upstream.tag ||
    history[history.length - 1].commit !== manifest.upstream.commit
  ) {
    throw new Error('Upstream adoption history must end at the pinned tag and commit');
  }
  const fixture = paths.has('--release-file');
  const release = fixture
    ? JSON.parse(readFileSync(paths.get('--release-file'), 'utf8'))
    : await github(repository, 'releases/latest');
  const tag = release.tag_name;
  if (!TAG_PATTERN.test(tag ?? '') || release.draft || release.prerelease) {
    throw new Error('Expected a stable version tag');
  }
  const url = `https://github.com/${repository}/releases/tag/${tag}`;
  if (release.html_url !== url) throw new Error('Release URL does not match the upstream repository');
  let commit = release.commit_sha;
  if (!fixture) {
    const ref = await github(repository, `git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
      object = (await github(repository, `git/tags/${object.sha}`)).object;
    }
    if (object?.type !== 'commit') throw new Error('Release tag does not resolve to a commit');
    commit = object.sha;
  }
  if (!COMMIT_PATTERN.test(commit ?? '')) throw new Error('Missing or invalid release commit');
  const current = tag === manifest.upstream.tag && commit === manifest.upstream.commit;
  const result = {
    status: current ? 'current' : 'review_required',
    studioRepository: manifest.repository,
    upstreamRepository: repository,
    pinnedTag: manifest.upstream.tag,
    pinnedCommit: manifest.upstream.commit,
    pinnedReleaseUrl: `https://github.com/${repository}/releases/tag/${manifest.upstream.tag}`,
    adoptionHistory: history,
    latestTag: tag,
    latestCommit: commit,
    releaseUrl: url,
    source: fixture ? 'local_fixture' : 'github',
    compareUrl: `https://github.com/${repository}/compare/${manifest.upstream.commit}...${commit}`,
    pinnedAioncore: manifest.aioncore.version,
  };
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Aelix Studio upstream check\n\nStatus: **${result.status}**\n\nSource: ${repository}\n\nPinned: ${result.pinnedTag} (${result.pinnedCommit})\n\nLatest: ${tag} (${commit})\n\nRelease: ${url}\n\nCompare: ${result.compareUrl}\n\nNo repository or installed application was changed.\n`
    );
  }
  console.log(JSON.stringify(result, null, 2));
  if (failOnDrift && !current) process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ status: 'error', message }, null, 2));
  console.error(message);
  process.exitCode = 1;
}
