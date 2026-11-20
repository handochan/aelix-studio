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

function createAsset(name = cli): string {
  const payload = path.join(root, name);
  fs.mkdirSync(payload, { recursive: true });
  fs.writeFileSync(path.join(payload, name), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  const arch = os.arch() === 'x64' ? 'x86_64' : 'arm64';
  const tarball = path.join(mirror, `v${version}`, `${cli}-${version}-${os.platform()}-${arch}.tar.gz`);
  fs.mkdirSync(path.dirname(tarball), { recursive: true });
  execFileSync('tar', ['-czf', tarball, '-C', root, name]);
  fs.writeFileSync(`${tarball}.sha256`, createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'));
  return tarball;
}

function install(...args: string[]) {
  return spawnSync('bash', [installer, '--mirror', `file://${mirror}`, '--version', version, '--no-path', ...args], {
    env: { HOME: home, PATH: process.env.PATH },
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
    const result = install('--install-dir', upstreamDir);
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

  it('keeps the installed version when the new archive has the wrong payload', () => {
    createAsset();
    const first = install();
    expect(first.status, first.stderr).toBe(0);
    createAsset('aionui-web');
    expect(install().stderr).toContain('Tarball structure is invalid');
    expect(execFileSync(studioLink, ['version'], { encoding: 'utf8' }).trim()).toBe(version);
  });
});
