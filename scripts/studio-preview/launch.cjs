/** Launch the installed ACP wheel with the verified public native CLI. No shell parsing. */
const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(
  path.join(__dirname, 'adapter/bin/aelix-acp'),
  ['--aelix', path.join(__dirname, 'native/bin/aelix'), ...process.argv.slice(2)],
  { stdio: 'inherit', shell: false }
);
child.on('error', () => {
  console.error('Preview ACP could not start');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
