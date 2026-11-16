/**
 * Full verification gate (Issue #43, decision D19).
 *
 * "Full verification" is the expensive tier of CI: the five-target Provider Preview installers,
 * the build tests, the io_uring tracepoint probe and the installed-app outbound audit. A pull
 * request skips it only when every file it changes is in the skip set below; anything else,
 * including a path nobody thought of, runs. This module is the one place that decides, for both
 * `pr-checks.yml` and `studio-outbound.yml`. It changes when those jobs run, never what they check.
 */

/** Pull request label that requests full verification whatever the pull request changes. */
export const FULL_VERIFY_LABEL = 'full-verify';

/**
 * The skip set: renderer UI code, unit tests and docs (owner decision, 2026-11-17). A pull request
 * skips full verification only when every changed file matches an entry here and none matches
 * `FORCED_PATHS`.
 *
 * Pattern syntax: `**` matches any number of path segments (`**` followed by `/` also matches no
 * directory at all), `*` matches within one segment, everything else is literal. Patterns are
 * matched against the whole repository-relative path.
 *
 * Markdown in other trees is not skipped on purpose. Nothing shows that such a file is
 * documentation rather than something a build packages or the harness reads, so only the two
 * places known to hold documentation are listed.
 */
export const SKIP_PATHS = [
  {
    pattern: 'packages/desktop/src/renderer/**',
    reason: 'renderer UI code; it reaches the installer only as bundled screens',
  },
  {
    pattern: 'tests/unit/**',
    reason: 'unit tests; the always-on Unit Tests job runs them, full verification neither runs nor reads them',
  },
  { pattern: 'docs/**', reason: 'documentation; not built, packaged or read by the verification harness' },
  { pattern: '*.md', reason: 'root-level Markdown (readme, changelog, contributor and agent guides); not packaged' },
];

/**
 * Renderer files the full-verification harness reads or drives by content. They sit inside the
 * skip set but always run.
 */
export const FORCED_PATHS = [
  {
    pattern: 'packages/desktop/src/renderer/pages/conversation/Preview/components/editors/OfflineMonacoEditor.tsx',
    reason: 'bundled by path by scripts/outbound-audit/bundles/monacoSmoke.mjs',
  },
  {
    pattern: 'packages/desktop/src/renderer/pages/conversation/Preview/components/editors/localMonaco.ts',
    reason: 'imported by OfflineMonacoEditor.tsx, so bundled by the same smoke',
  },
  {
    pattern: 'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent/**',
    reason: 'Provider settings UI that scripts/studio-preview/providerSmoke.py hashes and providerHostSmoke.mjs drives',
  },
  {
    pattern: 'packages/desktop/src/renderer/services/i18n/locales/*/settings.json',
    reason: 'strings scripts/studio-preview/providerHostSmoke.mjs reads to drive the Provider settings UI',
  },
];

/**
 * Copy of `on.pull_request.paths-ignore` in `pr-checks.yml` (a test keeps the two equal). When
 * every changed file matches, PR Checks does not start, so neither its gate nor the label can run
 * the jobs it holds. Used for a note in the summary only, never for the decision.
 */
export const PR_CHECKS_IGNORED_PATHS = ['**/*.md', 'docs/**', '.vscode/**', '.github/ISSUE_TEMPLATE/**'];

const escapeLiteral = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Compile a path pattern into an anchored regular expression. */
function compile(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 3;
    } else if (pattern.startsWith('**', index)) {
      source += '.*';
      index += 2;
    } else if (pattern[index] === '*') {
      source += '[^/]*';
      index += 1;
    } else {
      source += escapeLiteral(pattern[index]);
      index += 1;
    }
  }
  // dotAll: a newline in a file name must not change what a `**` entry matches.
  return new RegExp(`^${source}$`, 's');
}

const withExpressions = (entries) => entries.map((entry) => ({ ...entry, expression: compile(entry.pattern) }));
const SKIP = withExpressions(SKIP_PATHS);
const FORCED = withExpressions(FORCED_PATHS);
const PR_CHECKS_IGNORED = PR_CHECKS_IGNORED_PATHS.map(compile);

const find = (entries, file) => entries.find(({ expression }) => expression.test(file));

/**
 * Classify one changed file.
 *
 * @param {string} file Repository-relative path with forward slashes.
 * @returns {{ skippable: boolean, pattern?: string, reason: string }} `skippable` is true only for
 *   a file in the skip set that the harness does not read; `pattern` is the entry that matched.
 */
export function classifyChangedFile(file) {
  const forced = find(FORCED, file);
  if (forced) return { skippable: false, pattern: forced.pattern, reason: forced.reason };
  const skip = find(SKIP, file);
  if (skip) return { skippable: true, pattern: skip.pattern, reason: skip.reason };
  return { skippable: false, reason: 'outside the skip set' };
}

/**
 * @typedef {object} GateInput
 * @property {string} eventName GitHub event name of the workflow run.
 * @property {string[]} [labels] Labels on the pull request.
 * @property {string[] | null} [changedFiles] Files the pull request changes, or null when the
 *   list could not be computed.
 *
 * @typedef {object} GateDecision
 * @property {boolean} run Whether the full-verification jobs run.
 * @property {'schedule' | 'dispatch' | 'unknown-event' | 'label' | 'diff-unavailable' | 'no-files' | 'outside-skip-set' | 'skip-set'} code
 * @property {string} reason One-line explanation for people reading the check summary.
 * @property {{ file: string, reason: string }[]} blockers Changed files that need full verification.
 * @property {{ pattern: string, count: number }[]} skipped Skip-set entries the other files matched.
 * @property {boolean} prChecksIgnored True when every changed file matches the `paths-ignore` of
 *   `pr-checks.yml`, so that workflow does not start for this pull request.
 */

/** @returns {GateDecision} */
const verdict = (run, code, reason, detail = {}) => ({
  run,
  code,
  reason,
  blockers: [],
  skipped: [],
  prChecksIgnored: false,
  ...detail,
});

/**
 * Decide whether full verification runs. Only a pull request with a known, non-empty list of
 * changed files that all sit in the skip set is skipped, so an unexpected input can cost CI time
 * but cannot skip verification.
 *
 * @param {GateInput} input
 * @returns {GateDecision}
 */
export function decideFullVerification({ eventName, labels = [], changedFiles = null }) {
  if (eventName === 'schedule') return verdict(true, 'schedule', 'daily scheduled run on main');
  if (eventName === 'workflow_dispatch') return verdict(true, 'dispatch', 'manual run (workflow_dispatch)');
  if (eventName !== 'pull_request')
    return verdict(true, 'unknown-event', `event "${eventName}" is not gated, so full verification runs`);

  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const blockers = [];
  const counts = new Map();
  for (const file of files) {
    const { skippable, pattern, reason } = classifyChangedFile(file);
    if (skippable) counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    else blockers.push({ file, reason });
  }
  const detail = {
    blockers,
    skipped: [...counts].map(([pattern, count]) => ({ pattern, count })),
    prChecksIgnored: files.length > 0 && files.every((file) => PR_CHECKS_IGNORED.some((e) => e.test(file))),
  };

  if (labels.some((label) => label.toLowerCase() === FULL_VERIFY_LABEL))
    return verdict(true, 'label', `the pull request carries the \`${FULL_VERIFY_LABEL}\` label`, detail);
  if (!Array.isArray(changedFiles))
    return verdict(
      true,
      'diff-unavailable',
      'the changed-file list could not be computed, so full verification runs to stay safe'
    );
  if (files.length === 0)
    return verdict(
      true,
      'no-files',
      'the pull request lists no changed files, so nothing shows it can be skipped and full verification runs'
    );
  if (blockers.length > 0)
    return verdict(
      true,
      'outside-skip-set',
      `changed files outside the skip set (renderer UI, unit tests, docs): ${blockers.length} of ${files.length}`,
      detail
    );
  return verdict(
    false,
    'skip-set',
    `all ${files.length} changed file(s) are in the skip set (renderer UI, unit tests, docs) ` +
      `and the pull request has no \`${FULL_VERIFY_LABEL}\` label`,
    detail
  );
}

const SUMMARY_FILE_LIMIT = 20;

/** File names come from the pull request, so keep them inert inside a Markdown table cell. */
const inert = (file) => file.replace(/[^\p{L}\p{N} ._/@+,=~()#%&!'-]/gu, '?');

/**
 * Render the decision for `$GITHUB_STEP_SUMMARY`. A skip must never read as a pass.
 *
 * @param {GateDecision} decision
 * @param {string} jobs Human-readable names of the jobs this gate controls.
 * @returns {string} Markdown.
 */
export function renderGateSummary(decision, jobs) {
  const lines = [];
  if (decision.run) {
    lines.push('## Full verification: running', '', `- **Jobs:** ${jobs}`, `- **Why:** ${decision.reason}`);
  } else {
    lines.push(
      '## Full verification: SKIPPED (not run, not passed)',
      '',
      `- **Jobs not run:** ${jobs}. They show as skipped; a skipped job is not a pass.`,
      `- **Why:** ${decision.reason}`,
      `- **Skip-set entries matched:** ${decision.skipped.map(({ pattern, count }) => `\`${pattern}\` (${count})`).join(', ')}`,
      `- **To run them:** add the \`${FULL_VERIFY_LABEL}\` label to the pull request, or start this workflow manually (workflow_dispatch).`,
      '- **Safety net:** main is fully verified by the daily scheduled run.'
    );
  }
  if (decision.prChecksIgnored)
    lines.push(
      '',
      '> **PR Checks does not start for this pull request.** Every changed file matches its `paths-ignore` ' +
        '(Markdown, `docs/`, `.vscode/`, issue templates), so that workflow never reaches its gate and the ' +
        `\`${FULL_VERIFY_LABEL}\` label covers only the jobs named above. For the Provider Preview installers, ` +
        'Build Test and the io_uring probe, run PR Checks manually (workflow_dispatch with `pr_number`).'
    );
  if (decision.run && decision.blockers.length > 0) {
    lines.push('', '| Changed file | Why it needs full verification |', '| --- | --- |');
    for (const { file, reason } of decision.blockers.slice(0, SUMMARY_FILE_LIMIT))
      lines.push(`| \`${inert(file)}\` | ${reason} |`);
    if (decision.blockers.length > SUMMARY_FILE_LIMIT)
      lines.push(`| … and ${decision.blockers.length - SUMMARY_FILE_LIMIT} more | |`);
  }
  return lines.join('\n') + '\n';
}
