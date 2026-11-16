/**
 * Full verification gate (Issue #43, decision D19).
 *
 * "Full verification" is the expensive tier of CI: the five-target Provider Preview installers,
 * the build tests, the io_uring tracepoint probe and the installed-app outbound audit. It runs
 * only when it matters, so a pull request that changes nothing but screens or tests does not
 * wait for it. This module is the one place that decides, for both `pr-checks.yml` and
 * `studio-outbound.yml`. It changes when those jobs run, never what they check.
 */

/** Pull request label that requests full verification regardless of the changed paths. */
export const FULL_VERIFY_LABEL = 'full-verify';

/**
 * Install, runtime and outbound paths. A pull request that adds, changes, deletes or moves a file
 * on this list gets full verification.
 *
 * Pattern syntax: `**` matches any number of path segments, `*` matches within one segment, and
 * everything else is literal. Patterns are matched against the whole repository-relative path.
 *
 * The list is what the full-verification jobs execute, build from or package, minus the screen
 * side of the app: `packages/desktop/src/renderer/**`, the shared `packages/desktop/src/common/**`
 * and `uno.config.ts`. Those are left out on purpose (D19): they change with almost every screen
 * change, so a regression that only they introduce is caught by the daily scheduled run on main.
 */
export const FULL_VERIFY_PATHS = [
  // Verification harness and the build scripts every installer build executes
  // (build-with-builder.js, build-mcp-servers.js, prepareHubResources.js, afterPack.js, ...).
  'scripts/**',
  // Python suites that only the full-verification jobs run.
  'tests/studio-preview/**',
  'tests/outbound-audit/**',

  // Dependency installation.
  'package.json',
  'bun.lock',
  '.npmrc',
  'patches/**',

  // Build and packaging definition: electron-builder.yml, electron.vite.config.ts and the
  // workspace manifest sit directly in packages/desktop.
  'packages/desktop/*',
  'tsconfig.json',
  'entitlements.plist',
  'resources/**',
  'public/**',
  'packages/shared-scripts/**',

  // Runtime: main-process entry and code, the preload bridge and the web host.
  'packages/desktop/src/index.ts',
  'packages/desktop/src/process/**',
  'packages/desktop/src/preload/**',
  'packages/web-host/**',

  // CI definition, including this gate.
  '.github/workflows/**',
  '.github/actions/**',
];

const escapeLiteral = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** Compile a path pattern into an anchored regular expression. */
const compile = (pattern) =>
  new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) => part.split('*').map(escapeLiteral).join('[^/]*'))
        .join('.*') +
      '$',
    // dotAll: a newline in a file name must not let it slip past a `**` entry.
    's'
  );

const COMPILED_PATHS = FULL_VERIFY_PATHS.map((pattern) => ({ pattern, expression: compile(pattern) }));

/**
 * Find the path-list entry that covers a changed file.
 *
 * @param {string} file Repository-relative path with forward slashes.
 * @returns {string | undefined} The matching pattern, if any.
 */
export function matchFullVerifyPath(file) {
  return COMPILED_PATHS.find(({ expression }) => expression.test(file))?.pattern;
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
 * @property {'schedule' | 'dispatch' | 'unknown-event' | 'label' | 'diff-unavailable' | 'paths' | 'no-match'} code
 * @property {string} reason One-line explanation for people reading the check summary.
 * @property {{ file: string, pattern: string }[]} matches Changed files on the path list.
 */

/** @returns {GateDecision} */
const verdict = (run, code, reason, matches = []) => ({ run, code, reason, matches });

/**
 * Decide whether full verification runs. Everything that is not a pull request with a known,
 * unmatched file list runs, so an unexpected input can cost CI time but cannot skip verification.
 *
 * @param {GateInput} input
 * @returns {GateDecision}
 */
export function decideFullVerification({ eventName, labels = [], changedFiles = null }) {
  if (eventName === 'schedule') return verdict(true, 'schedule', 'daily scheduled run on main');
  if (eventName === 'workflow_dispatch') return verdict(true, 'dispatch', 'manual run (workflow_dispatch)');
  if (eventName !== 'pull_request')
    return verdict(true, 'unknown-event', `event "${eventName}" is not gated, so full verification runs`);

  const known = Array.isArray(changedFiles);
  const matches = (known ? changedFiles : []).flatMap((file) => {
    const pattern = matchFullVerifyPath(file);
    return pattern ? [{ file, pattern }] : [];
  });

  if (labels.some((label) => label.toLowerCase() === FULL_VERIFY_LABEL))
    return verdict(true, 'label', `the pull request carries the \`${FULL_VERIFY_LABEL}\` label`, matches);
  if (!known)
    return verdict(
      true,
      'diff-unavailable',
      'the changed-file list could not be computed, so full verification runs to stay safe'
    );
  if (matches.length > 0)
    return verdict(
      true,
      'paths',
      `changed files on the install/runtime/outbound path list: ${matches.length} of ${changedFiles.length}`,
      matches
    );
  return verdict(
    false,
    'no-match',
    `no changed file is on the install/runtime/outbound path list (${changedFiles.length} checked) ` +
      `and the pull request has no \`${FULL_VERIFY_LABEL}\` label`
  );
}

const SUMMARY_MATCH_LIMIT = 20;

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
      `- **To run them:** add the \`${FULL_VERIFY_LABEL}\` label to the pull request, or start this workflow manually (workflow_dispatch).`,
      '- **Safety net:** main is fully verified by the daily scheduled run.'
    );
  }
  if (decision.matches.length > 0) {
    lines.push('', '| Changed file | Path-list entry |', '| --- | --- |');
    for (const { file, pattern } of decision.matches.slice(0, SUMMARY_MATCH_LIMIT))
      lines.push(`| \`${inert(file)}\` | \`${pattern}\` |`);
    if (decision.matches.length > SUMMARY_MATCH_LIMIT)
      lines.push(`| … and ${decision.matches.length - SUMMARY_MATCH_LIMIT} more | |`);
  }
  return lines.join('\n') + '\n';
}
