import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installer = path.resolve('scripts/install-web.sh');
const version = '2.2.2-beta.1';
const cli = 'aelix-studio-web';

let root: string;
let home: string;
let mirror: string;
let studioLink: string;
let upstreamDir: string;
let upstreamLink: string;

function createAsset(
  name = cli,
  resources: 'files' | 'directories' | 'command-directory' | 'none' = 'files',
  prepare?: (payload: string) => void
): string {
  const staging = fs.mkdtempSync(path.join(root, 'stage-'));
  const payload = path.join(staging, name);
  fs.mkdirSync(payload);
  fs.writeFileSync(path.join(payload, name), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  if (resources !== 'none') {
    const host = path.join(payload, 'bundled-aioncore', `${os.platform()}-${os.arch()}`);
    fs.mkdirSync(host, { recursive: true });
    fs.writeFileSync(path.join(host, 'aelix-studio-host'), 'stub', { mode: 0o755 });
    fs.mkdirSync(path.join(payload, 'static'));
    if (resources === 'directories') {
      fs.mkdirSync(path.join(payload, 'package.json'));
      fs.mkdirSync(path.join(payload, 'static/index.html'));
    } else {
      fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ version }));
      fs.writeFileSync(path.join(payload, 'static/index.html'), '<html></html>');
    }
    if (resources === 'command-directory') fs.mkdirSync(path.join(payload, 'bin', cli), { recursive: true });
    if (os.platform() === 'linux') fs.writeFileSync(path.join(payload, 'aelix-studio-web.service'), '[Service]\n');
  }
  prepare?.(payload);
  const arch = os.arch() === 'x64' ? 'x86_64' : 'arm64';
  const tarball = path.join(mirror, `v${version}`, `${cli}-${version}-${os.platform()}-${arch}.tar.gz`);
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  execFileSync('tar', ['-czf', tarball, '-C', staging, name]);
  fs.writeFileSync(`${tarball}.sha256`, createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'));
  return tarball;
}

function installerArgs(args: string[], updatePath?: boolean): string[] {
  return [
    installer,
    '--mirror',
    `file://${mirror}`,
    '--version',
    version,
    ...(updatePath ? [] : ['--no-path']),
    ...args,
  ];
}

function install(args: string[] = [], binDir?: string, options?: { cwd?: string; updatePath?: boolean }) {
  return spawnSync('bash', installerArgs(args, options?.updatePath), {
    cwd: options?.cwd,
    env: { HOME: home, PATH: process.env.PATH, BIN_DIR: binDir, SHELL: '/bin/bash' },
    encoding: 'utf8',
  });
}

async function listenLocal(server: http.Server | https.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an IP listener');
  return address.port;
}

describe.skipIf(process.platform === 'win32')('standalone Studio WebUI installer', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-web-install-'));
    home = path.join(root, 'test home');
    mirror = path.join(root, 'mirror');
    const bin = path.join(home, '.local/bin');
    studioLink = path.join(bin, cli);
    upstreamDir = path.join(home, '.local/share/aionui-web');
    upstreamLink = path.join(bin, 'aionui-web');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(upstreamDir, { recursive: true });
    const executable = path.join(upstreamDir, 'aionui-web');
    fs.writeFileSync(executable, 'upstream', { mode: 0o755 });
    fs.symlinkSync(executable, upstreamLink);
  });

  afterEach(() => fs.rmSync(root, { force: true, recursive: true }));

  it('installs a prerelease beside the original executable and link', () => {
    createAsset();
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(execFileSync(studioLink, ['version'], { encoding: 'utf8' }).trim()).toBe(version);
    expect(fs.readFileSync(upstreamLink, 'utf8')).toBe('upstream');
  });

  it('refuses an explicit install directory belonging to AionUi', () => {
    const result = install(['--install-dir', upstreamDir]);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(upstreamLink, 'utf8')).toBe('upstream');
  });

  it('preserves the AionUi command when a marked Studio layout shares the AionUi installation directory', () => {
    createAsset();
    const first = install();
    expect(first.status, first.stderr).toBe(0);
    fs.cpSync(path.dirname(fs.realpathSync(studioLink)), upstreamDir, { recursive: true });
    fs.writeFileSync(path.join(upstreamDir, 'aionui-web'), '#!/bin/sh\nprintf upstream\n');
    const result = install(['--install-dir', upstreamDir, '--no-symlink']);
    expect(result.stderr).toContain('contains AionUi WebUI');
    expect(execFileSync(upstreamLink, { encoding: 'utf8' })).toBe('upstream');
  });

  it('upgrades an unmarked Studio installation from its own directory using --install-dir .', () => {
    createAsset();
    const first = install();
    expect(first.status, first.stderr).toBe(0);
    const installDir = path.dirname(fs.realpathSync(studioLink));
    fs.unlinkSync(path.join(installDir, '.aelix-studio-web-install'));
    fs.unlinkSync(studioLink);
    fs.symlinkSync(`${installDir}/./${cli}`, studioLink);
    const result = install(['--install-dir', '.'], undefined, { cwd: installDir });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.realpathSync(studioLink)).toBe(path.join(installDir, cli));
    expect(fs.readdirSync(path.dirname(installDir)).some((entry) => entry.startsWith(`${cli}.backup.`))).toBe(true);
  });

  it('loads a literal dollar sign from both the generated Bash profile and the PATH instruction', () => {
    createAsset();
    const profile = path.join(home, '.bashrc');
    fs.writeFileSync(profile, '');
    const binDir = path.join(home, 'bin $STUDIO_PATH_VARIABLE');
    const result = install([], binDir, { updatePath: true });
    expect(result.status, result.stderr).toBe(0);
    const summary = result.stdout.match(/^    (export PATH=.*)$/m)?.[1];
    expect(summary).toBeDefined();
    for (const pathCommand of ['. "$HOME/.bashrc"', summary]) {
      const listed = execFileSync('bash', ['-c', `${pathCommand}\nprintf '%s' "\${PATH%%:*}"`], {
        env: { HOME: home, PATH: process.env.PATH, STUDIO_PATH_VARIABLE: 'expanded' },
        encoding: 'utf8',
      });
      expect(listed).toBe(fs.realpathSync(binDir));
    }
  });

  it.each(['absolute', 'relative'])('rejects a tarball with an %s link to a file outside the installation', (kind) => {
    const outside = path.join(home, '.local/share/outside');
    fs.writeFileSync(outside, 'outside');
    createAsset(cli, 'files', (payload) => {
      fs.symlinkSync(kind === 'absolute' ? outside : '../../../outside', path.join(payload, 'static/escape'));
    });
    const result = install();
    expect(result.stderr).toMatch(/absolute link|link escapes its installation tree/);
    expect(fs.existsSync(studioLink)).toBe(false);
  });

  it.each([false, true])(
    'rejects a link that leaves the payload and reenters by its old name (sibling: %s)',
    (sibling) => {
      const installDir = path.join(root, 'custom Studio installation');
      if (sibling) {
        const siblingStatic = path.join(root, cli, 'static');
        fs.mkdirSync(siblingStatic, { recursive: true });
        fs.writeFileSync(path.join(siblingStatic, 'version.json'), 'external');
      }
      createAsset(cli, 'files', (payload) => {
        fs.renameSync(path.join(payload, 'package.json'), path.join(payload, 'static/version.json'));
        fs.symlinkSync(`../${cli}/static/version.json`, path.join(payload, 'package.json'));
      });

      const result = install(['--install-dir', installDir]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('link escapes its installation tree');
      expect(fs.existsSync(installDir)).toBe(false);
    }
  );

  it('preserves a relative link that resolves inside a renamed installation', () => {
    const installDir = path.join(root, 'custom Studio installation');
    createAsset(cli, 'files', (payload) => {
      fs.symlinkSync('../package.json', path.join(payload, 'static/version.json'));
    });
    const result = install(['--install-dir', installDir]);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.realpathSync(path.join(installDir, 'static/version.json'))).toBe(
      fs.realpathSync(path.join(installDir, 'package.json'))
    );
  });

  it('ignores a dangling BIN_DIR when both the command link and profile update are disabled', () => {
    createAsset();
    const installDir = path.join(root, 'custom Studio installation');
    const binDir = path.join(root, 'dangling bin directory');
    const missing = path.join(root, 'missing');
    fs.symlinkSync(missing, binDir);
    const result = install(['--install-dir', installDir, '--no-symlink'], binDir);
    expect(result.status, result.stderr).toBe(0);
    expect(execFileSync(path.join(installDir, cli), ['version'], { encoding: 'utf8' }).trim()).toBe(version);
    expect(fs.readlinkSync(binDir)).toBe(missing);
    expect(result.stdout).not.toContain(binDir);
  });

  it('rejects a plain HTTP mirror before attempting a download', () => {
    const result = install(['--mirror', 'http://127.0.0.1:1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Mirrors must use HTTPS or a local file:// path');
  });

  it('disables automatic redirects when GNU Wget is the online downloader', () => {
    const toolDir = path.join(root, 'tools');
    fs.mkdirSync(toolDir);
    for (const command of ['bash', 'uname', 'realpath', 'dirname', 'basename', 'mktemp', 'rm']) {
      const executable = execFileSync('bash', ['-c', 'command -v "$1"', 'bash', command], { encoding: 'utf8' }).trim();
      fs.symlinkSync(executable, path.join(toolDir, command));
    }
    fs.writeFileSync(path.join(toolDir, 'wget'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$HOME/wget-args"\nexit 8\n', {
      mode: 0o755,
    });
    const result = spawnSync('bash', installerArgs(['--mirror', 'https://releases.example.invalid']), {
      env: { HOME: home, PATH: toolDir },
      encoding: 'utf8',
    });
    expect(result.stderr).toContain('Use curl for mirrors that redirect');
    expect(fs.readFileSync(path.join(home, 'wget-args'), 'utf8').split('\n')).toContain('--max-redirect=0');
  });

  it('follows HTTPS redirects and refuses HTTP redirects for both release assets', async () => {
    const tarball = createAsset();
    const key = path.join(root, 'local.key');
    const cert = path.join(root, 'local.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' }
    );
    const requests: string[] = [];
    const plain = http.createServer((request, response) => {
      requests.push(request.url ?? '');
      response.end('plain HTTP');
    });
    const plainPort = await listenLocal(plain);
    const tls = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
      const url = request.url ?? '';
      const checksum = url.endsWith('.sha256');
      if ((url.startsWith('/redirect-archive/') && !checksum) || (url.startsWith('/redirect-checksum/') && checksum)) {
        response.writeHead(302, { Location: `http://127.0.0.1:${plainPort}/plain` }).end();
      } else if (url.startsWith('/secure/')) {
        response.writeHead(302, { Location: checksum ? '/files/checksum' : '/files/archive' }).end();
      } else {
        response.end(fs.readFileSync(checksum || url === '/files/checksum' ? `${tarball}.sha256` : tarball));
      }
    });
    try {
      const tlsPort = await listenLocal(tls);
      for (const route of ['redirect-archive', 'redirect-checksum', 'secure']) {
        const child = spawn('bash', installerArgs(['--mirror', `https://127.0.0.1:${tlsPort}/${route}`]), {
          env: { HOME: home, PATH: process.env.PATH, CURL_CA_BUNDLE: cert },
          stdio: 'ignore',
        });
        const [status] = await once(child, 'close');
        expect(status).toBe(route === 'secure' ? 0 : 1);
      }
      expect(requests).toEqual([]);
    } finally {
      tls.close();
      plain.close();
    }
  });

  it('preserves a foreign link at the requested command path', () => {
    fs.symlinkSync(upstreamLink, studioLink);
    const result = install();
    expect(result.status).toBe(1);
    expect(fs.readlinkSync(studioLink)).toBe(upstreamLink);
  });

  it('rejects an archive with a mismatched checksum', () => {
    fs.appendFileSync(createAsset(), 'corrupt');
    const result = install();
    expect(result.stderr).toContain('Checksum mismatch');
    expect(fs.existsSync(studioLink)).toBe(false);
  });

  it('keeps the existing install in place when the new command directory is blocked', () => {
    createAsset();
    const first = install();
    expect(first.status, first.stderr).toBe(0);
    const blockedBin = path.join(root, 'blocked-bin');
    fs.writeFileSync(blockedBin, 'existing file');
    const result = install([], path.join(blockedBin, 'bin'));
    expect(result.stderr).toContain('the new installation was rolled back');
    expect(fs.readdirSync(path.join(home, '.local/share')).toSorted()).toEqual([cli, 'aionui-web'].toSorted());
    expect(execFileSync(studioLink, ['version'], { encoding: 'utf8' }).trim()).toBe(version);
  });

  it('supports an explicitly nested command link', () => {
    createAsset();
    const nestedBin = path.join(home, '.local/share', cli, 'bin');
    const result = install([], nestedBin);
    expect(result.status, result.stderr).toBe(0);
    expect(execFileSync(path.join(nestedBin, cli), ['version'], { encoding: 'utf8' }).trim()).toBe(version);
  });

  it('rolls back when the payload occupies an explicitly nested command path', () => {
    createAsset(cli, 'command-directory');
    const installDir = path.join(home, '.local/share', cli);
    const result = install([], path.join(installDir, 'bin'));
    expect(result.stderr).toContain('the new installation was rolled back');
    expect(fs.existsSync(installDir)).toBe(false);
  });

  it('rejects a tarball that puts directories where metadata and the SPA entry should be', () => {
    createAsset(cli, 'directories');
    const result = install();
    expect(result.stderr).toContain('missing package.json');
    expect(fs.existsSync(studioLink)).toBe(false);
  });

  it.each(['aionui-web', cli])('keeps the installed version when the new %s archive is incomplete', (name) => {
    createAsset();
    const first = install();
    expect(first.status, first.stderr).toBe(0);
    createAsset(name, 'none');
    expect(install().stderr).toContain('Tarball structure is invalid');
    expect(execFileSync(studioLink, ['version'], { encoding: 'utf8' }).trim()).toBe(version);
  });
});
