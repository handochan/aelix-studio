/** Read-only upstream release check; never merges, installs, or publishes. */
import { appendFileSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../docs/aelix-studio/upstream.json', import.meta.url), 'utf8'));
const repository = manifest.upstream.repository;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid upstream repository');

async function github(path) {
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
  const fixture = args.length === 2 && args[0] === '--release-file';
  if (args.length !== 0 && !fixture)
    throw new Error('Usage: checkUpstream.mjs [--release-file PATH] [--fail-on-drift]');
  const release = fixture ? JSON.parse(readFileSync(args[1], 'utf8')) : await github('releases/latest');
  const tag = release.tag_name;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || release.draft || release.prerelease) {
    throw new Error('Expected a stable version tag');
  }
  const url = `https://github.com/${repository}/releases/tag/${tag}`;
  if (release.html_url !== url) throw new Error('Release URL does not match the upstream repository');
  let commit = release.commit_sha;
  if (!fixture) {
    const ref = await github(`git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth += 1) {
      object = (await github(`git/tags/${object.sha}`)).object;
    }
    if (object?.type !== 'commit') throw new Error('Release tag does not resolve to a commit');
    commit = object.sha;
  }
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Missing or invalid release commit');
  const current = tag === manifest.upstream.tag && commit === manifest.upstream.commit;
  const result = {
    status: current ? 'current' : 'review_required',
    pinnedTag: manifest.upstream.tag,
    pinnedCommit: manifest.upstream.commit,
    latestTag: tag,
    latestCommit: commit,
    releaseUrl: url,
    source: fixture ? 'local_fixture' : 'github',
    compareUrl: `https://github.com/${repository}/compare/${manifest.upstream.commit}...${commit}`,
    pinnedAioncore: manifest.aioncore.version,
  };
  console.log(JSON.stringify(result, null, 2));
  if (failOnDrift && !current) process.exitCode = 2;
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Aelix Studio upstream check\n\nStatus: **${result.status}**\n\nPinned: ${result.pinnedTag} (${result.pinnedCommit})\n\nLatest: ${tag} (${commit})\n\n${url}\n\nNo repository or installed application was changed.\n`
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
