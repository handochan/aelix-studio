import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import {
  FORCED_PATHS,
  PR_CHECKS_IGNORED_PATHS,
  SKIP_PATHS,
  classifyChangedFile,
  decideFullVerification,
  renderGateSummary,
} from '../../../.github/actions/full-verify-gate/gate.mjs';

const projectRoot = resolve(__dirname, '../../..');
const actionDir = resolve(projectRoot, '.github/actions/full-verify-gate');

const RENDERER = 'packages/desktop/src/renderer/**';
const EDITORS = 'packages/desktop/src/renderer/pages/conversation/Preview/components/editors';
const PROVIDER_UI = 'packages/desktop/src/renderer/components/settings/SettingsModal/contents/ModelModalContent';
const LOCALES = 'packages/desktop/src/renderer/services/i18n/locales';
// The reviewer's case: main-process runtime that lives in the shared tree.
const COMMON_RUNTIME = 'packages/desktop/src/common/platform/ElectronPlatformServices.ts';

describe('full verification skip set', () => {
  const skippable: [string, string][] = [
    ['packages/desktop/src/renderer/pages/guid/index.tsx', RENDERER],
    ['packages/desktop/src/renderer/components/settings/SettingsModal/index.tsx', RENDERER],
    [`${LOCALES}/en-US/acp.json`, RENDERER],
    ['tests/unit/build-scripts/fullVerifyGate.test.ts', 'tests/unit/**'],
    ['docs/studio-outbound/README.md', 'docs/**'],
    ['docs/studio-outbound/ipv6Measurements.json', 'docs/**'],
    ['readme.md', '*.md'],
    ['CONTRIBUTING.zh.md', '*.md'],
  ];

  it.each(skippable)('%s can be skipped (%s)', (file, pattern) => {
    expect(classifyChangedFile(file)).toMatchObject({ skippable: true, pattern });
  });

  it('has an example for every skip entry', () => {
    expect([...new Set(skippable.map(([, pattern]) => pattern))].toSorted()).toEqual(
      SKIP_PATHS.map(({ pattern }) => pattern).toSorted()
    );
  });

  // Renderer files the harness reads or drives by content always run.
  const forced: [string, string][] = [
    [`${EDITORS}/OfflineMonacoEditor.tsx`, `${EDITORS}/OfflineMonacoEditor.tsx`],
    [`${EDITORS}/localMonaco.ts`, `${EDITORS}/localMonaco.ts`],
    [`${PROVIDER_UI}/NativeProviders.tsx`, `${PROVIDER_UI}/**`],
    [`${PROVIDER_UI}/nativeAuth.ts`, `${PROVIDER_UI}/**`],
    [`${LOCALES}/en-US/settings.json`, `${LOCALES}/*/settings.json`],
    [`${LOCALES}/ko-KR/settings.json`, `${LOCALES}/*/settings.json`],
  ];

  it.each(forced)('%s always runs although it is renderer code', (file, pattern) => {
    expect(classifyChangedFile(file)).toMatchObject({ skippable: false, pattern });
  });

  it('still forces a run when a file name under a forced directory contains a newline', () => {
    expect(classifyChangedFile(`${PROVIDER_UI}/a\nb.tsx`)).toMatchObject({
      skippable: false,
      pattern: `${PROVIDER_UI}/**`,
    });
  });

  it('has an example for every forced entry', () => {
    expect([...new Set(forced.map(([, pattern]) => pattern))].toSorted()).toEqual(
      FORCED_PATHS.map(({ pattern }) => pattern).toSorted()
    );
  });

  it.each([
    COMMON_RUNTIME,
    'packages/desktop/src/common/adapter/ipcBridge.ts',
    'packages/desktop/src/process/bridge/index.ts',
    'packages/desktop/src/preload/main.ts',
    'packages/desktop/src/index.ts',
    'packages/desktop/src/types.d.ts',
    'packages/desktop/src/renderer.ts',
    'packages/desktop/src/brand-new/module.ts',
    'packages/desktop/electron-builder.yml',
    'packages/web-host/src/static-server.ts',
    'packages/web-host/README.md',
    'packages/web-cli/src/index.ts',
    'tests/studio-preview/test_packaging.py',
    'tests/outbound-audit/README.md',
    'tests/e2e/features/conversations/acp/studio-runtime-settings.e2e.ts',
    'tests/integration/i18n-packaged.test.ts',
    'tests/vitest.setup.ts',
    'tests/unitx/a.test.ts',
    'resources/hub/README.md',
    'public/pwa/notes.md',
    'scripts/outbound-audit/README.md',
    'scripts/packaged-launch.mjs',
    '.github/workflows/README.md',
    '.github/workflows/pr-checks.yml',
    'docsx/guide.txt',
    'brand-new-directory/anything.ts',
    'brand-new-directory/notes.md',
    'package.json',
    'bun.lock',
    'uno.config.ts',
    'LICENSE',
  ])('%s is outside the skip set', (file) => {
    expect(classifyChangedFile(file)).toEqual({ skippable: false, reason: 'outside the skip set' });
  });
});

describe('full verification decision', () => {
  const renderer = 'packages/desktop/src/renderer/pages/guid/index.tsx';
  const unitTest = 'tests/unit/guid.dom.test.tsx';

  it.each([
    { name: 'renderer-only pull request', labels: [], changedFiles: [renderer], run: false, code: 'skip-set' },
    {
      name: 'renderer, unit test, docs and root Markdown together',
      labels: [],
      changedFiles: [renderer, unitTest, 'docs/guide.md', 'CHANGELOG.md'],
      run: false,
      code: 'skip-set',
    },
    {
      name: 'renderer-only pull request with an unrelated label',
      labels: ['enhancement'],
      changedFiles: [renderer],
      run: false,
      code: 'skip-set',
    },
    {
      name: 'shared main-process runtime alone',
      labels: [],
      changedFiles: [COMMON_RUNTIME],
      run: true,
      code: 'outside-skip-set',
    },
    {
      name: 'one file outside the skip set among renderer files',
      labels: [],
      changedFiles: [renderer, unitTest, 'packages/desktop/src/process/bridge/index.ts'],
      run: true,
      code: 'outside-skip-set',
    },
    {
      name: 'renderer file the harness reads',
      labels: [],
      changedFiles: [renderer, `${LOCALES}/en-US/settings.json`],
      run: true,
      code: 'outside-skip-set',
    },
    {
      name: 'file in a brand-new top-level directory',
      labels: [],
      changedFiles: [renderer, 'brand-new-directory/anything.ts'],
      run: true,
      code: 'outside-skip-set',
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
    { name: 'pull request that lists no changed files', labels: [], changedFiles: [], run: true, code: 'no-files' },
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
    const decision = decideFullVerification({ eventName, changedFiles: [renderer] });

    expect({ run: decision.run, code: decision.code }).toEqual({ run: true, code });
  });

  it('reports each file that needs full verification and why', () => {
    const decision = decideFullVerification({
      eventName: 'pull_request',
      changedFiles: [renderer, COMMON_RUNTIME, `${EDITORS}/localMonaco.ts`],
    });

    expect(decision.blockers).toEqual([
      { file: COMMON_RUNTIME, reason: 'outside the skip set' },
      { file: `${EDITORS}/localMonaco.ts`, reason: expect.stringContaining('OfflineMonacoEditor.tsx') },
    ]);
  });
});

describe('full verification summary', () => {
  const skip = decideFullVerification({
    eventName: 'pull_request',
    changedFiles: [
      'packages/desktop/src/renderer/a.tsx',
      'packages/desktop/src/renderer/b.tsx',
      'tests/unit/a.test.ts',
    ],
  });

  it('states a skip as not run and not passed, and how to run it', () => {
    const summary = renderGateSummary(skip, 'App outbound');

    expect(summary).toContain('SKIPPED (not run, not passed)');
    expect(summary).toContain('Jobs not run:** App outbound');
    expect(summary).toContain('add the `full-verify` label');
  });

  it('names the skip-set entries that allowed the skip', () => {
    expect(renderGateSummary(skip, 'jobs')).toContain('`packages/desktop/src/renderer/**` (2), `tests/unit/**` (1)');
  });

  it('does not describe a run as skipped and lists what forced it', () => {
    const decision = decideFullVerification({ eventName: 'pull_request', changedFiles: [COMMON_RUNTIME] });
    const summary = renderGateSummary(decision, 'App outbound');

    expect(summary).not.toContain('SKIPPED');
    expect(summary).toContain(`| \`${COMMON_RUNTIME}\` | outside the skip set |`);
  });

  it('keeps hostile file names inert in the table', () => {
    const decision = decideFullVerification({
      eventName: 'pull_request',
      changedFiles: ['scripts/a|b`c\n<img>.js'],
    });

    expect(renderGateSummary(decision, 'jobs')).toContain('| `scripts/a?b?c??img?.js` |');
  });

  it('says the label cannot start PR Checks when only ignored paths changed', () => {
    const decision = decideFullVerification({
      eventName: 'pull_request',
      labels: ['full-verify'],
      changedFiles: ['docs/guide.md', 'scripts/outbound-audit/README.md'],
    });
    const summary = renderGateSummary(decision, 'App outbound');

    expect(decision.run).toBe(true);
    expect(summary).toContain('PR Checks does not start for this pull request');
    expect(summary).toContain('workflow_dispatch with `pr_number`');
  });

  it('leaves that note out when PR Checks starts', () => {
    expect(renderGateSummary(skip, 'jobs')).not.toContain('PR Checks does not start');
  });
});

type Step = { uses?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: {
    pull_request: { types: string[]; 'paths-ignore'?: string[] };
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
const productCheckout = (job: Job): Step | undefined => job.steps?.find((step) => step.uses === 'actions/checkout@v4');

describe('full verification workflow wiring', () => {
  const GATED = "needs.full-verify-gate.outputs.run == 'true'";
  const prChecks = loadWorkflow('pr-checks.yml');
  const outbound = loadWorkflow('studio-outbound.yml');
  const workflows: Record<string, Workflow> = { 'pr-checks.yml': prChecks, 'studio-outbound.yml': outbound };
  const files = Object.keys(workflows);
  const fullJobs = [
    ['pr-checks.yml', 'io-uring-trace-probe'],
    ['pr-checks.yml', 'provider-preview'],
    ['pr-checks.yml', 'build-test'],
    ['studio-outbound.yml', 'installed-app-outbound'],
    ['studio-outbound.yml', 'local-installer-report'],
  ];

  it.each(fullJobs)('%s: %s runs only when the gate says so', (file, id) => {
    const job = workflows[file].jobs[id];

    expect(needsOf(job)).toContain('full-verify-gate');
    expect(job.if).toContain(GATED);
  });

  // On a scheduled run the tested commit must be the event commit that the tracking Issue names.
  it.each(fullJobs)('%s: %s checks out the event commit on a scheduled run', (file, id) => {
    const ref = String(productCheckout(workflows[file].jobs[id])?.with?.ref);

    expect(ref).toMatch(
      file === 'pr-checks.yml'
        ? /^\$\{\{ inputs\.commit_sha \|\| \(github\.event_name == 'schedule' && github\.sha\) \|\| github\.ref \}\}$/
        : /^\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/
    );
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

  it('mirrors the paths-ignore of pr-checks.yml for the summary note', () => {
    expect(PR_CHECKS_IGNORED_PATHS).toEqual(prChecks.on.pull_request['paths-ignore']);
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
  });

  // Policy: failed jobs and jobs cancelled inside a live run are tracked; a cancelled run is not.
  it.each(files)('%s tracks scheduled failures but not a run cancelled as a whole', (file) => {
    const condition = workflows[file].jobs['scheduled-failure'].if ?? '';

    expect(condition).toMatch(/^\$\{\{ !cancelled\(\) && github\.event_name == 'schedule' && \(/);
    expect(condition).toContain("contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')");
  });
});

// The gate only ever runs on ubuntu-latest, so the shell fixture is exercised on POSIX hosts.
const available = (command: string): boolean => spawnSync(command, ['--version']).status === 0;
const describeShell = process.platform !== 'win32' && available('bash') && available('git') ? describe : describe.skip;

describeShell('gate action script on real merge commits', () => {
  let root = '';
  let repository = '';
  let script = '';
  const isolated = {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };

  function git(...args: string[]): void {
    const result = spawnSync('git', args, { cwd: repository, env: isolated, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function write(file: string, content: string): void {
    mkdirSync(dirname(join(repository, file)), { recursive: true });
    writeFileSync(join(repository, file), content);
  }

  /** Create a branch from main, apply a change and commit it. */
  function branch(name: string, change: () => void): void {
    git('checkout', '--quiet', '-b', name, 'main');
    change();
    git('add', '--all');
    git('commit', '--quiet', '-m', name);
    git('checkout', '--quiet', 'main');
  }

  /** Run the `run:` script of action.yml in the fixture, as the composite action would. */
  function runGate(labels: string[] | string = []): { status: number | null; output: string; summary: string } {
    const temp = mkdtempSync(join(root, 'run-'));
    const output = join(temp, 'output');
    const summary = join(temp, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = spawnSync('bash', [script], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...isolated,
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_ACTION_PATH: actionDir,
        GATE_EVENT_NAME: 'pull_request',
        GATE_LABELS: typeof labels === 'string' ? labels : JSON.stringify(labels),
        GATE_JOBS: 'App outbound',
      },
    });
    return { status: result.status, output: readFileSync(output, 'utf8'), summary: readFileSync(summary, 'utf8') };
  }

  /** Check out what GitHub checks out for a pull request: the merge of the branch into main. */
  function testMerge(name: string): void {
    git('checkout', '--quiet', '--detach', 'main');
    git('merge', '--quiet', '--no-ff', '-m', `merge ${name}`, name);
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'full-verify-gate-'));
    repository = join(root, 'repository');
    mkdirSync(repository);
    script = join(root, 'gate.sh');
    const action = yaml.load(readFileSync(join(actionDir, 'action.yml'), 'utf8')) as {
      runs: { steps: { run: string }[] };
    };
    writeFileSync(script, action.runs.steps[0].run);

    git('init', '--quiet', '--initial-branch', 'main');
    write('packages/desktop/src/renderer/a.tsx', 'a');
    write('packages/desktop/src/process/b.ts', 'b');
    write(COMMON_RUNTIME, 'c');
    git('add', '--all');
    git('commit', '--quiet', '-m', 'base');
    branch('renderer-only', () => write('packages/desktop/src/renderer/a.tsx', 'a2'));
    branch('common-runtime', () => write(COMMON_RUNTIME, 'c2'));
    branch('moved-into-renderer', () =>
      git('mv', 'packages/desktop/src/process/b.ts', 'packages/desktop/src/renderer/b.ts')
    );
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('skips a renderer-only merge and says so in the summary', () => {
    testMerge('renderer-only');
    const result = runGate();

    expect(result.output).toMatch(/^run=false$/m);
    expect(result.summary).toContain('SKIPPED (not run, not passed)');
  });

  it('runs when only shared main-process runtime changed', () => {
    testMerge('common-runtime');

    expect(runGate().output).toMatch(/^run=true$/m);
  });

  it('runs when a file moves out of the main process into the renderer', () => {
    testMerge('moved-into-renderer');

    expect(runGate().output).toMatch(/^run=true$/m);
  });

  it('runs a renderer-only merge that carries the label', () => {
    testMerge('renderer-only');

    expect(runGate(['full-verify']).output).toMatch(/^run=true$/m);
  });

  it('runs when the checkout is not a merge commit, because the diff is unknown', () => {
    git('checkout', '--quiet', '--detach', 'renderer-only');
    const result = runGate();

    expect(result.output).toMatch(/^run=true$/m);
    expect(result.output).toContain('could not be computed');
  });

  it('fails the step instead of deciding when the labels are malformed', () => {
    testMerge('renderer-only');
    const result = runGate('{"not":"a list"}');

    expect(result.status).not.toBe(0);
    expect(result.output).not.toMatch(/^run=/m);
  });
});
