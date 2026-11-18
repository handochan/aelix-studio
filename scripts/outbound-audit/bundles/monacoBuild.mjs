import path from 'node:path';
import { withBuildProcesses } from './buildProcesses.mjs';

/** Build inside the audited command and retire all build services before Electron. */
export async function buildMonacoResources(directory, dictionarySource, record) {
  let esbuild;
  return withBuildProcesses(
    async () => {
      const { build } = await import('vite');
      esbuild = await import('esbuild');
      await build({
        configFile: false,
        root: directory,
        base: './',
        logLevel: 'error',
        build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
        worker: { format: 'es' },
      });
      const compiled = path.join(directory, 'dictionaryServer.cjs');
      await esbuild.build({
        entryPoints: [dictionarySource],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: compiled,
      });
      return compiled;
    },
    () => esbuild?.stop(),
    { record }
  );
}
