import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import childProcess from 'node:child_process';
import assert from 'node:assert/strict';
import { buildMonacoResources } from '../../scripts/outbound-audit/bundles/monacoBuild.mjs';
import { withBuildProcesses } from '../../scripts/outbound-audit/bundles/buildProcesses.mjs';

const [mode, directory] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '../..');
const dictionary = path.join(root, 'packages/desktop/src/process/resources/dictionaryServer.ts');
if (mode === 'tail-send') {
  let child;
  await withBuildProcesses(
    async () => {
      // The TCP and UDP attempts occur only after stop has returned. Waiting
      // for helper exit must retain both in the enclosing command's audit.
      child = childProcess.spawn(process.execPath, [
        '--input-type=module',
        '-e',
        `import net from 'node:net'; import dgram from 'node:dgram';
        process.stdin.resume(); process.stdout.write('ready');
        process.stdin.on('end', () => setTimeout(() => {
          const tcp=net.connect({host:'203.0.113.1',port:443});
          tcp.on('error',()=>{});tcp.setTimeout(200,()=>tcp.destroy());
          const udp=dgram.createSocket('udp4');udp.on('error',()=>{});
          udp.send('control',53,'203.0.113.1',()=>udp.close());
        },100));`,
      ]);
      await once(child.stdout, 'data');
    },
    () => child.stdin.end(),
    { record: (value) => console.log(JSON.stringify(value)) }
  );
} else {
  await fs.writeFile(path.join(directory, 'index.html'), '<script type="module" src="./main.js"></script>');
  await fs.writeFile(
    path.join(directory, 'main.js'),
    "new Worker(new URL('./worker.js', import.meta.url), {type:'module'});"
  );
  await fs.writeFile(path.join(directory, 'worker.js'), "postMessage('local HTML worker fixture');");
  if (mode === 'managed' || mode === 'assertion-failure') {
    await buildMonacoResources(directory, dictionary, (value) => console.log(JSON.stringify(value)));
    if (mode === 'assertion-failure') assert.fail('Synthetic HTML worker assertion failure');
  } else {
    const { build } = await import('vite');
    const esbuild = createRequire(import.meta.url)('esbuild');
    await build({
      configFile: false,
      root: directory,
      base: './',
      logLevel: 'error',
      build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
      worker: { format: 'es' },
    });
    const options = {
      entryPoints: [dictionary],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(directory, 'dictionaryServer.cjs'),
    };
    if (mode === 'baseline') esbuild.buildSync(options);
    else if (mode === 'async-only') await esbuild.build(options);
    else throw new Error('Unknown fixture mode');
    // Preserve the old fixture's natural process-exit cleanup for comparison.
    let buildHelperPids;
    if (process.platform === 'linux') {
      const children = await Promise.all(
        (await fs.readdir('/proc/self/task')).map(async (tid) => {
          try {
            return (await fs.readFile(`/proc/self/task/${tid}/children`, 'utf8'))
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .map(Number);
          } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
          }
        })
      );
      buildHelperPids = [...new Set(children.flat())];
    }
    console.log(JSON.stringify({ status: 'built', mode, buildHelperPids }));
  }
}
