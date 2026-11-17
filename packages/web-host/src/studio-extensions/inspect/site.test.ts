import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentDistributions, readSite } from './site';

describe('reading a site-packages directory', () => {
  let site = '';
  beforeEach(async () => {
    site = await mkdtemp(path.join(os.tmpdir(), 'studio-site-'));
  });
  afterEach(() => rm(site, { recursive: true, force: true }));
  const distribution = async (info: string, files: Record<string, string>): Promise<void> => {
    await mkdir(path.join(site, info), { recursive: true });
    await Promise.all(Object.entries(files).map(([name, text]) => writeFile(path.join(site, info, name), text)));
  };

  it('lists distributions with their RECORD hash and files, and their extension entries', async () => {
    const record = 'demo/__init__.py,sha256=x,1\n../../../bin/demo,sha256=y,2\n';
    await distribution('demo-1.0.dist-info', {
      METADATA: 'Name: Demo\nVersion: 1.0\n',
      RECORD: record,
      'entry_points.txt': '[aelix.extensions]\ndemo-ext = demo:setup\n',
    });
    await distribution('plain-2.0.dist-info', { METADATA: 'Name: plain\nVersion: 2.0\n', RECORD: '' });
    const snapshot = await readSite(site);
    expect(snapshot.problems).toEqual([]);
    expect(snapshot.distributions.get('demo')).toEqual({
      name: 'demo',
      version: '1.0',
      recordSha256: createHash('sha256').update(record).digest('hex'),
      info: 'demo-1.0.dist-info',
      files: ['demo/__init__.py', '../../../bin/demo'],
    });
    expect([...snapshot.extensions]).toEqual([['demo-ext', { reference: 'demo:setup', distribution: 'demo' }]]);
  });

  it('collects top-level names and startup entries, leaving metadata and caches out', async () => {
    await Promise.all(
      ['Demo', 'demo-1.0.dist-info', 'demo-1.0.data', '__pycache__', 'bin', 'sitecustomize'].map((name) =>
        mkdir(path.join(site, name))
      )
    );
    await Promise.all(['six.py', 'evil.pth'].map((name) => writeFile(path.join(site, name), '')));
    const snapshot = await readSite(site);
    expect([...snapshot.topLevel].toSorted()).toEqual(['demo', 'evil', 'sitecustomize', 'six']);
    expect(snapshot.startup).toEqual(['evil.pth', 'sitecustomize']);
  });

  it('treats a directory that does not exist as empty', async () => {
    const snapshot = await readSite(path.join(site, 'absent'));
    expect([snapshot.distributions.size, snapshot.extensions.size, snapshot.problems]).toEqual([0, 0, []]);
  });

  it('reports metadata that cannot serve as a ledger', async () => {
    await distribution('demo-1.0.dist-info', {
      METADATA: 'Name: demo\nVersion: 1.0\n',
      RECORD: '',
      'entry_points.txt': '[aelix.extensions]\nshared = demo:setup\n',
    });
    await distribution('demo-2.0.dist-info', { METADATA: 'Name: demo\nVersion: 2.0\n', RECORD: '' });
    await distribution('other-1.0.dist-info', {
      METADATA: 'Name: other\nVersion: 1.0\n',
      'entry_points.txt': '[aelix.extensions]\nshared = other:setup\n',
    });
    await distribution('broken-1.0.dist-info', { RECORD: '' });
    const snapshot = await readSite(site);
    expect(snapshot.problems.toSorted()).toEqual([
      'broken-1.0.dist-info has no readable METADATA',
      'distribution demo is recorded twice',
      'extension shared is provided twice',
      'other-1.0.dist-info has no RECORD',
    ]);
    expect(snapshot.distributions.get('demo')?.version).toBe('1.0');
    expect(snapshot.distributions.get('other')).toMatchObject({ recordSha256: '', files: [] });
  });

  it('separates the installer from the content of a generation', async () => {
    await distribution('pip-26.0.dist-info', { METADATA: 'Name: pip\nVersion: 26.0\n', RECORD: '' });
    await distribution('demo-1.0.dist-info', { METADATA: 'Name: demo\nVersion: 1.0\n', RECORD: '' });
    expect(contentDistributions(await readSite(site)).map((entry) => entry.name)).toEqual(['demo']);
  });
});
