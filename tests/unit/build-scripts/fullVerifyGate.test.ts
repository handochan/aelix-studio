import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import {
  FULL_VERIFY_PATHS,
  decideFullVerification,
  matchFullVerifyPath,
  renderGateSummary,
} from '../../../.github/actions/full-verify-gate/gate.mjs';

const projectRoot = resolve(__dirname, '../../..');

describe('full verification path list', () => {
  // One changed file per path-list entry, so a new entry needs an example here.
  const covered: [string, string][] = [
    ['scripts/studio-preview/packaging/build.mjs', 'scripts/**'],
    ['tests/studio-preview/test_packaging.py', 'tests/studio-preview/**'],
    ['tests/outbound-audit/test_audit.py', 'tests/outbound-audit/**'],
    ['package.json', 'package.json'],
    ['bun.lock', 'bun.lock'],
    ['.npmrc', '.npmrc'],
    ['patches/7zip-bin@5.2.0.patch', 'patches/**'],
    ['packages/desktop/electron-builder.yml', 'packages/desktop/*'],
    ['tsconfig.json', 'tsconfig.json'],
    ['entitlements.plist', 'entitlements.plist'],
    ['resources/windows/support/report-installer-failure.ps1', 'resources/**'],
    ['public/sw.js', 'public/**'],
    ['packages/shared-scripts/src/prepare-aioncore.js', 'packages/shared-scripts/**'],
    ['packages/desktop/src/index.ts', 'packages/desktop/src/index.ts'],
    ['packages/desktop/src/process/bridge/index.ts', 'packages/desktop/src/process/**'],
    ['packages/desktop/src/preload/main.ts', 'packages/desktop/src/preload/**'],
    ['packages/web-host/src/static-server.ts', 'packages/web-host/**'],
    ['.github/workflows/pr-checks.yml', '.github/workflows/**'],
    ['.github/actions/full-verify-gate/gate.mjs', '.github/actions/**'],
  ];

  it.each(covered)('%s is covered by %s', (file, pattern) => {
    expect(matchFullVerifyPath(file)).toBe(pattern);
  });

  it('still matches a listed directory when the file name contains a newline', () => {
    expect(matchFullVerifyPath('packages/desktop/src/process/a\nb.ts')).toBe('packages/desktop/src/process/**');
  });

  it('has an example for every entry', () => {
    expect(covered.map(([, pattern]) => pattern).toSorted()).toEqual(FULL_VERIFY_PATHS.toSorted());
  });

  // Renderer and shared source stay off the list, including files the harness reads by path.
  it.each([
    'packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx',
    'packages/desktop/src/renderer/pages/conversation/Preview/components/editors/OfflineMonacoEditor.tsx',
    'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent/index.tsx',
    'packages/desktop/src/renderer/services/i18n/locales/en-US/settings.json',
    'packages/desktop/src/renderer/components/settings/SettingsModal/index.tsx',
    'packages/desktop/src/common/adapter/ipcBridge.ts',
    'packages/desktop/src/types.d.ts',
    'packages/desktop/src/processor.ts',
    'packages/web-cli/src/index.ts',
    'tests/unit/build-scripts/fullVerifyGate.test.ts',
    'tests/e2e/features/conversations/acp/studio-runtime-settings.e2e.ts',
    'docs/studio-outbound/README.md',
    'resources.md',
    'package.json.bak',
    'nested/package.json',
    'uno.config.ts',
  ])('%s is not on the list', (file) => {
    expect(matchFullVerifyPath(file)).toBeUndefined();
  });
});

describe('full verification decision', () => {
  const renderer = 'packages/desktop/src/renderer/pages/guid/index.tsx';
  const mainProcess = 'packages/desktop/src/process/bridge/index.ts';

  it.each([
    { name: 'renderer-only pull request', labels: [], changedFiles: [renderer], run: false, code: 'no-match' },
    {
      name: 'test-only pull request',
      labels: [],
      changedFiles: ['tests/unit/x.test.ts'],
      run: false,
      code: 'no-match',
    },
    { name: 'pull request without changed files', labels: [], changedFiles: [], run: false, code: 'no-match' },
    {
      name: 'pull request with an unrelated label',
      labels: ['enhancement'],
      changedFiles: [renderer],
      run: false,
      code: 'no-match',
    },
    {
      name: 'pull request that touches a listed path',
      labels: [],
      changedFiles: [renderer, mainProcess],
      run: true,
      code: 'paths',
    },
    {
      name: 'renderer-only pull request labelled full-verify',
      labels: ['enhancement', 'full-verify'],
      changedFiles: [renderer],
      run: true,
      code: 'label',
    },
    {
      name: 'label written in another case',
      labels: ['Full-Verify'],
      changedFiles: [renderer],
      run: true,
      code: 'label',
    },
    {
      name: 'pull request whose diff is unavailable',
      labels: [],
      changedFiles: null,
      run: true,
      code: 'diff-unavailable',
    },
  ])('$name -> run=$run ($code)', ({ labels, changedFiles, run, code }) => {
    const decision = decideFullVerification({ eventName: 'pull_request', labels, changedFiles });

    expect({ run: decision.run, code: decision.code }).toEqual({ run, code });
  });

  it.each([
    ['schedule', 'schedule'],
    ['workflow_dispatch', 'dispatch'],
    ['push', 'unknown-event'],
    ['', 'unknown-event'],
  ])('event "%s" always runs (%s)', (eventName, code) => {
    const decision = decideFullVerification({ eventName, changedFiles: [] });

    expect({ run: decision.run, code: decision.code }).toEqual({ run: true, code });
  });

  it('reports which changed files matched which entry', () => {
    const decision = decideFullVerification({ eventName: 'pull_request', changedFiles: [renderer, mainProcess] });

    expect(decision.matches).toEqual([{ file: mainProcess, pattern: 'packages/desktop/src/process/**' }]);
  });
});

describe('full verification summary', () => {
  it('states a skip as not run and not passed, and how to run it', () => {
    const decision = decideFullVerification({ eventName: 'pull_request', changedFiles: ['docs/x.md'] });
    const summary = renderGateSummary(decision, 'App outbound');

    expect(summary).toContain('SKIPPED (not run, not passed)');
    expect(summary).toContain('App outbound');
    expect(summary).toContain('`full-verify` label');
  });

  it('does not describe a run as skipped', () => {
    const decision = decideFullVerification({ eventName: 'pull_request', changedFiles: ['bun.lock'] });
    const summary = renderGateSummary(decision, 'App outbound');

    expect(summary).not.toContain('SKIPPED');
    expect(summary).toContain('| `bun.lock` | `bun.lock` |');
  });

  it('keeps hostile file names inert in the table', () => {
    const decision = decideFullVerification({
      eventName: 'pull_request',
      changedFiles: ['scripts/a|b`c\n<img>.js'],
    });

    expect(renderGateSummary(decision, 'jobs')).toContain('| `scripts/a?b?c??img?.js` |');
  });
});

type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: { uses?: string; with?: Record<string, unknown> }[];
};
type Workflow = {
  on: {
    pull_request: { types: string[] };
    schedule: { cron: string }[];
    workflow_dispatch: { inputs?: Record<string, unknown> } | null;
  };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

function loadWorkflow(name: string): Workflow {
  return yaml.load(readFileSync(resolve(projectRoot, '.github/workflows', name), 'utf8')) as Workflow;
}

const needsOf = (job: Job): string[] => [job.needs ?? []].flat();

describe('full verification workflow wiring', () => {
  const GATED = "needs.full-verify-gate.outputs.run == 'true'";
  const prChecks = loadWorkflow('pr-checks.yml');
  const outbound = loadWorkflow('studio-outbound.yml');
  const workflows: Record<string, Workflow> = { 'pr-checks.yml': prChecks, 'studio-outbound.yml': outbound };
  const files = Object.keys(workflows);

  it.each([
    ['pr-checks.yml', 'io-uring-trace-probe'],
    ['pr-checks.yml', 'provider-preview'],
    ['pr-checks.yml', 'build-test'],
    ['studio-outbound.yml', 'installed-app-outbound'],
    ['studio-outbound.yml', 'local-installer-report'],
  ])('%s: %s runs only when the gate says so', (file, id) => {
    const job = workflows[file].jobs[id];

    expect(needsOf(job)).toContain('full-verify-gate');
    expect(job.if).toContain(GATED);
  });

  it.each(['code-quality', 'unit-tests', 'coverage-tests', 'i18n-check', 'release-script-test'])(
    'pr-checks.yml: %s stays outside the gate and outside the scheduled run',
    (id) => {
      const job = prChecks.jobs[id];

      expect(needsOf(job)).not.toContain('full-verify-gate');
      expect(job.if).toContain("github.event_name != 'schedule'");
    }
  );

  it('keeps the draft filter on the pull request gate and the cancel-on-close job', () => {
    expect(prChecks.jobs['full-verify-gate'].if).toContain('github.event.pull_request.draft == false');
    expect(prChecks.jobs['cancel-if-closed'].if).toBe("github.event.action == 'closed'");
  });

  it('keeps the manual inputs of pr-checks.yml', () => {
    expect(Object.keys(prChecks.on.workflow_dispatch?.inputs ?? {})).toEqual([
      'pr_number',
      'commit_sha',
      'skip_build_test',
    ]);
    expect(prChecks.jobs['build-test'].if).toContain('inputs.skip_build_test != true');
  });

  it.each(files)('%s starts on the label, manually and once a day', (file) => {
    const workflow = workflows[file];

    expect(workflow.on.pull_request.types).toContain('labeled');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.schedule.map(({ cron }) => cron.split(' ').slice(2))).toEqual([['*', '*', '*']]);
  });

  it.each(files)('%s computes the decision with the shared gate action', (file) => {
    const steps = workflows[file].jobs['full-verify-gate'].steps ?? [];

    expect(steps.map((step) => step.uses)).toEqual(['actions/checkout@v4', './.github/actions/full-verify-gate']);
    // The gate diffs GitHub's test merge commit (the default ref) against its first parent.
    expect(steps[0].with).toMatchObject({ 'fetch-depth': 2 });
    expect(steps[0].with).not.toHaveProperty('ref');
  });

  it.each(files)('%s grants issues: write to the scheduled failure tracker only', (file) => {
    const workflow = workflows[file];
    const writers = Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.issues === 'write')
      .map(([id]) => id);

    expect(writers).toEqual(['scheduled-failure']);
    expect(workflow.permissions?.issues).not.toBe('write');
    expect(workflow.jobs['scheduled-failure'].if).toContain("github.event_name == 'schedule'");
  });
});
