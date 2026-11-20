import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
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

function createAsset(name = cli, resources: 'files' | 'directories' | 'command-directory' | 'none' = 'files'): string {
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
  const arch = os.arch() === 'x64' ? 'x86_64' : 'arm64';
  const tarball = path.join(mirror, `v${version}`, `${cli}-${version}-${os.platform()}-${arch}.tar.gz`);
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  execFileSync('tar', ['-czf', tarball, '-C', staging, name]);
  fs.writeFileSync(`${tarball}.sha256`, createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'));
  return tarball;
}

function install(args: string[] = [], binDir?: string) {
  return spawnSync('bash', [installer, '--mirror', `file://${mirror}`, '--version', version, '--no-path', ...args], {
    env: { HOME: home, PATH: process.env.PATH, BIN_DIR: binDir },
    encoding: 'utf8',
  });
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
