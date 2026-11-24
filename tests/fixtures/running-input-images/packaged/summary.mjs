import fs from 'node:fs';

const {
  PREVIEW_TARGET,
  DISPATCH_INPUTS,
  DEPENDENCIES,
  PREPARE,
  PACKAGE,
  SCENARIOS,
  WEBUI_BROWSER_INSTALL,
  ACCEPTANCE_SHA,
  GITHUB_STEP_SUMMARY,
} = process.env;
const mib = (value) => (value / 1024 ** 2).toFixed(1);
fs.mkdirSync('.local', { recursive: true });

for (const [surface, artifact] of [
  ['electron', '.local/image-acceptance.json'],
  ['webui', '.local/image-acceptance-webui.json'],
]) {
  const report = fs.existsSync(artifact)
    ? JSON.parse(fs.readFileSync(artifact, 'utf8'))
    : {
        schema: 'studio.running-image-acceptance/1',
        target: PREVIEW_TARGET,
        surface,
        status: 'failed',
        stage:
          [
            ['dispatch-inputs', DISPATCH_INPUTS === 'failure' ? 'failure' : 'success'],
            ['dependencies', DEPENDENCIES],
            ['prepare', PREPARE],
            ['package', PACKAGE],
            ['browser-install', surface === 'webui' && WEBUI_BROWSER_INSTALL === 'failed' ? 'failure' : 'success'],
            ['scenarios', SCENARIOS],
          ].find(([, outcome]) => outcome !== 'success')?.[0] ?? 'missing-results',
        scenarios: [],
      };

  report.commit = ACCEPTANCE_SHA;
  fs.writeFileSync(artifact, JSON.stringify(report, null, 2) + '\n');
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
    '## Running-input images · ' + report.target + ' · ' + surface,
    '',
    '**' + report.status + '** · ' + report.stage,
    '',
    '| Scenario | Result | Stage | Notice | Native image writes | Provider images | ACK ms | Stop ACK ms | Peak RSS MiB (Studio / Host / ACP / native) |',
    '|---|---|---|---|---:|---:|---:|---:|---|',
    ...rows.map((row) => '| ' + row + ' |'),
    '',
    '',
  ];
  fs.appendFileSync(GITHUB_STEP_SUMMARY, table.join('\n'));
  if (report.status !== 'passed' || report.surface !== surface || report.scenarios.length !== 9) process.exitCode = 1;
}
if (SCENARIOS !== 'success') process.exitCode = 1;
