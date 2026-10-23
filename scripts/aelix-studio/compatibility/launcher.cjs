/** Use AionCore's managed Node resolver to pass executable paths with spaces intact. */
const { spawn } = require('node:child_process');
const path = require('node:path');

const python = path.join(__dirname, 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']));
const child = spawn(python, ['-I', '-B', path.join(__dirname, 'launch.py'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});
child.on('error', (error) => {
  console.error('Bundled Aelix could not start:', error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
