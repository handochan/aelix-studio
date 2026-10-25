/** Launch the installed ACP wheel with the verified public native CLI. No shell parsing. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const windows = process.platform === 'win32';
const bundled = fs.existsSync(path.join(__dirname, 'manifest.json'));
const directory = windows ? 'Scripts' : 'bin';
const pythonName = windows ? 'python.exe' : 'python';
const python = bundled
  ? path.join(__dirname, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3']))
  : path.join(__dirname, 'adapter', directory, pythonName);
const nativePython = path.join(__dirname, 'native', directory, pythonName);
const args = bundled
  ? ['-I', '-S', '-B', '-X', 'utf8', path.join(__dirname, 'launch.py'), 'acp']
  : [
      '-I',
      '-B',
      '-X',
      'utf8',
      '-c',
      'from aelix_acp.server import main; main()',
      '--aelix',
      nativePython,
      '--aelix-arg=-I',
      '--aelix-arg=-B',
      '--aelix-arg=-Xutf8',
      '--aelix-arg=-c',
      '--aelix-arg=from aelix_coding_agent.cli.entry import main_sync; main_sync()',
    ];
// Only this launcher holds the ACP input write end. Its death produces ACP EOF
// even when the backend still holds the launcher's own stdin pipe open.
const child = spawn(python, [...args, ...process.argv.slice(2)], {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: false,
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('error', () => {
  console.error('Preview ACP could not start');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdin.unpipe(child.stdin);
    child.stdin.end();
    // ACP EOF closes its workers; Windows owns them in a kill-on-close Job.
    // Escalate through the existing ChildProcess handle, never a PID lookup.
    const deadline = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 6500);
    deadline.unref();
  });
}
