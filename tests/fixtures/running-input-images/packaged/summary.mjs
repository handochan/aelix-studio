import fs from 'node:fs';

const artifact = '.local/image-acceptance.json';
const { PREVIEW_TARGET, DEPENDENCIES, PREPARE, PACKAGE, SCENARIOS, ACCEPTANCE_SHA, GITHUB_STEP_SUMMARY } = process.env;
const report = fs.existsSync(artifact)
  ? JSON.parse(fs.readFileSync(artifact, 'utf8'))
  : {
      schema: 'studio.running-image-acceptance/1',
      target: PREVIEW_TARGET,
      status: 'failed',
      stage:
        [
          ['dependencies', DEPENDENCIES],
          ['prepare', PREPARE],
          ['package', PACKAGE],
          ['scenarios', SCENARIOS],
        ].find(([, outcome]) => outcome !== 'success')?.[0] ?? 'missing-results',
      scenarios: [],
    };
report.commit = ACCEPTANCE_SHA;
fs.mkdirSync('.local', { recursive: true });
fs.writeFileSync(artifact, JSON.stringify(report, null, 2) + '\n');
const mib = (value) => (value / 1024 ** 2).toFixed(1);
const rows = report.scenarios.map((row) => {
  const rss = row.peakRssBytes ? Object.values(row.peakRssBytes).map(mib).join(' / ') : '–';
  return [
    row.scenario,
    row.status,
    row.stage,
    row.notice ?? '–',
    row.nativeImageWrites ?? '–',
    row.providerImageOccurrences ?? '–',
    row.ackMs ?? '–',
    row.stopAckMs ?? '–',
    rss,
  ].join(' | ');
});
const table = [
  '## Running-input images · ' + report.target,
  '',
  '**' + report.status + '** · ' + report.stage,
  '',
  '| Scenario | Result | Stage | Notice | Native image writes | Provider images | ACK ms | Stop ACK ms | Peak RSS MiB (Studio / Host / ACP / native) |',
  '|---|---|---|---|---:|---:|---:|---:|---|',
  ...rows.map((row) => '| ' + row + ' |'),
  '',
];
fs.appendFileSync(GITHUB_STEP_SUMMARY, table.join('\n'));
if (report.status !== 'passed' || SCENARIOS !== 'success') process.exitCode = 1;
