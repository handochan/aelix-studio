/**
 * The full-verification gate skips pull requests that only change renderer code. That is safe only
 * while every renderer file that is more than a screen is listed as forced. These tests derive such
 * files from the source instead of trusting the list: the import closure of the non-renderer code
 * and of the build configuration, and the renderer paths that the build configuration and the
 * verification harness name, whichever path alias spells them.
 *
 * What this does not guarantee: it catches a dependency that ordinary development adds (a new
 * import, a new copy target, a new literal path in a config or harness script). It does not try to
 * defeat deliberate circumvention, and it cannot see a dynamic import whose argument is not a
 * literal or a path computed at runtime. The daily run on main and release-candidate verification
 * cover what it cannot see. The suite is skipped on Windows; the ubuntu and macOS unit-test jobs
 * run it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { build, stop } from 'esbuild';
import yaml from 'js-yaml';
import {
  ACCEPTED_MAIN_BUNDLE_DATA,
  acceptedMainBundleData,
  classifyChangedFile,
} from '../../../.github/actions/full-verify-gate/gate.mjs';

type StaticCopyOptions = { targets: { src: string | string[] }[] };
type BuildSection = {
  resolve?: { alias?: Record<string, string> };
  build?: { rollupOptions?: { input?: Record<string, string> } };
};
type BuildConfig = { main: BuildSection; preload: BuildSection; renderer?: BuildSection };
type Reference = { file: string; reference: string };

// Record what the build copies verbatim instead of loading the real plugin.
const captured = vi.hoisted(() => ({ staticCopy: [] as StaticCopyOptions[] }));
vi.mock('vite-plugin-static-copy', () => ({
  viteStaticCopy: (options: StaticCopyOptions) => {
    captured.staticCopy.push(options);
    return { name: 'captured-static-copy' };
  },
}));

const projectRoot = resolve(__dirname, '../../..');
const RENDERER = 'packages/desktop/src/renderer';
// Build configuration that is executed, not bundled. What it imports is traced like source code.
const BUILD_CONFIG_ENTRIES = ['packages/desktop/electron.vite.config.ts'];
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const NOT_BUNDLED = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/;
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|ya?ml|py|sh|ps1|nsh)$/;

const fromRoot = (file: string): string => relative(projectRoot, file).split(sep).join('/');

/** Every file below a directory, as repository-relative paths with forward slashes. */
function filesUnder(directory: string): string[] {
  const absolute = resolve(projectRoot, directory);
  return (readdirSync(absolute, { recursive: true }) as string[])
    .map((name) => join(absolute, name))
    .filter((file) => statSync(file).isFile())
    .map(fromRoot);
}

const rendererFiles = filesUnder(RENDERER);

/** What an alias of the build points at. The build keeps an alias for a directory that is gone. */
const kindOf = (path: string): 'directory' | 'file' | 'missing' => {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return 'missing';
  return stats.isDirectory() ? 'directory' : 'file';
};

/** A renderer file is forced when the gate refuses to skip it. */
const isForced = (file: string): boolean => !classifyChangedFile(file).skippable;

/**
 * Renderer files a path reference stands for: everything that starts with the text before its
 * first glob character. A directory therefore stands for all files below it.
 */
const referencedFiles = (reference: string): string[] => {
  const prefix = reference.split(/[*?{[]/)[0];
  return rendererFiles.filter((file) => file.startsWith(prefix));
};

/** Every string anywhere inside a parsed YAML or JSON value. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : [];
};

// Path aliases of tsconfig.json. Harness scripts run through tsx resolve imports with them.
const tsconfigPaths = (
  JSON.parse(readFileSync(resolve(projectRoot, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  }
).compilerOptions.paths;
const withoutWildcard = (path: string): string => path.replace(/\/\*$/, '');

/** What every path alias points at, from tsconfig.json and from each section of the build. */
const aliasTargets = (buildConfig: BuildConfig): [string, string][] => [
  ...Object.entries(tsconfigPaths).flatMap(([key, targets]) =>
    targets.map((target): [string, string] => [
      withoutWildcard(key),
      fromRoot(resolve(projectRoot, withoutWildcard(target))),
    ])
  ),
  ...[buildConfig.main, buildConfig.preload, buildConfig.renderer].flatMap((section) =>
    Object.entries(section?.resolve?.alias ?? {}).map(([key, target]): [string, string] => [key, fromRoot(target)])
  ),
];

/**
 * Every way a path into the renderer tree can be spelled, mapped to the repository path it stands
 * for: the directory itself, and each alias that points at it, inside it, or at a parent of it
 * (`@renderer/x` and `@/renderer/x` today). Derived, so the next alias is recognised as well.
 */
function rendererSpellings(targets: [string, string][]): Map<string, string> {
  const spellings = new Map([[RENDERER, RENDERER]]);
  for (const [key, target] of targets) {
    if (target === RENDERER || target.startsWith(`${RENDERER}/`)) spellings.set(key, target);
    else if (RENDERER.startsWith(`${target}/`)) spellings.set(`${key}/${RENDERER.slice(target.length + 1)}`, RENDERER);
  }
  return spellings;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Renderer paths written in a text, with every alias spelling expanded to a repository path. */
function rendererReferences(text: string, spellings: Map<string, string>): string[] {
  const longestFirst = [...spellings.keys()].toSorted((a, b) => b.length - a.length);
  // A spelling, not followed by more of a name, then the rest of the path.
  const pattern = new RegExp('(?:' + longestFirst.map(escapeRegExp).join('|') + ')(?![\\w-])(?:/[\\w@.*{},/-]*)?', 'g');
  const expand = (path: string): string => {
    const spelling = longestFirst.find((candidate) => path.startsWith(candidate)) ?? RENDERER;
    return (spellings.get(spelling) + path.slice(spelling.length)).replace(/[/.,]+$/, '');
  };
  return [...new Set((text.match(pattern) ?? []).map(expand))];
}

// What the bundles are built from does not depend on the host, so POSIX hosts check it; the
// always-on Unit Tests job runs on ubuntu and macOS as well as Windows.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

describeOnPosix('renderer dependencies of the non-renderer code and the build', () => {
  let config: BuildConfig;
  let aliases: Record<string, string> = {};
  let roots: string[] = [];
  let closure: string[] = [];
  let externalImports: string[] = [];

  beforeAll(async () => {
    const exported: unknown = (await import('../../../packages/desktop/electron.vite.config')).default;
    config = (
      typeof exported === 'function'
        ? await (exported as (env: { mode: string; command: string }) => unknown)({
            mode: 'production',
            command: 'build',
          })
        : exported
    ) as BuildConfig;
    aliases = { ...config.preload.resolve?.alias, ...config.main.resolve?.alias };

    // Every non-renderer module the main, preload and builtin-MCP bundles can be built from is a
    // root, so the result does not depend on knowing the entry points. The build configuration is
    // a root as well, which also covers what it imports, such as uno.config.ts.
    roots = [
      ...filesUnder('packages/desktop/src').filter((file) => !file.startsWith(`${RENDERER}/`)),
      ...filesUnder('packages/web-host/src'),
      ...filesUnder('packages/shared-scripts/src'),
      ...BUILD_CONFIG_ENTRIES,
    ].filter((file) => SOURCE_FILE.test(file) && !NOT_BUNDLED.test(file));

    const result = await build({
      absWorkingDir: projectRoot,
      stdin: {
        contents: roots.map((file) => `import ${JSON.stringify(`./${file}`)};`).join('\n'),
        resolveDir: projectRoot,
        sourcefile: 'non-renderer-roots.ts',
        loader: 'ts',
      },
      bundle: true,
      write: false,
      metafile: true,
      outdir: 'full-verify-closure-is-never-written',
      platform: 'node',
      format: 'esm',
      packages: 'external',
      // Report each file at the path it was imported by, not at the target of a symlink.
      preserveSymlinks: true,
      logLevel: 'silent',
      // Directory aliases of the build. An alias that points at one file is checked separately.
      alias: Object.fromEntries(Object.entries(aliases).filter(([, target]) => kindOf(target) === 'directory')),
      loader: Object.fromEntries(
        ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.wasm', '.node', '.html', '.md', '.txt'].map(
          (extension) => [extension, 'file' as const]
        )
      ),
    });
    const inputs = result.metafile.inputs;
    closure = Object.keys(inputs)
      .filter((file) => file.startsWith(`${RENDERER}/`))
      .toSorted();
    externalImports = [
      ...new Set(
        Object.values(inputs).flatMap((input) => input.imports.filter((item) => item.external).map((item) => item.path))
      ),
    ];
  });

  afterAll(async () => {
    await stop();
  });

  describe('renderer files in the main-process import closure', () => {
    it('finds the closure from every build entry', () => {
      const entries = [config.main, config.preload].flatMap((section) =>
        Object.values(section.build?.rollupOptions?.input ?? {}).map(fromRoot)
      );

      expect(entries).toContain('packages/desktop/src/index.ts');
      expect(roots).toEqual(expect.arrayContaining([...entries, ...BUILD_CONFIG_ENTRIES]));
    });

    // Guards against an empty closure that would make the next test pass without checking anything.
    it('sees the locale modules that the main process imports', () => {
      expect(closure).toContain(`${RENDERER}/services/i18n/locales/en-US/index.ts`);
      expect(closure).toContain(`${RENDERER}/services/i18n/locales/en-US/update.json`);
    });

    it('resolves every project alias instead of leaving it external', () => {
      const keys = Object.keys(aliases);
      const leaked = externalImports.filter((path) =>
        keys.some((key) => kindOf(aliases[key]) !== 'file' && (path === key || path.startsWith(`${key}/`)))
      );

      expect(keys).toEqual(expect.arrayContaining(Object.keys(tsconfigPaths).map(withoutWildcard)));
      expect(leaked).toEqual([]);
    });

    // The closure is resolved with one alias table, which is only right while the sections agree.
    it('uses the same target for an alias in the main and preload builds', () => {
      const main = config.main.resolve?.alias ?? {};
      const preload = config.preload.resolve?.alias ?? {};

      expect(Object.keys(preload).filter((key) => key in main && main[key] !== preload[key])).toEqual([]);
    });

    it('is forced or accepted as data, file by file', () => {
      const unclassified = closure.filter((file) => !isForced(file) && !acceptedMainBundleData(file));

      // A file listed here is imported by non-renderer code. Add it to FORCED_PATHS in
      // .github/actions/full-verify-gate/gate.mjs, or to ACCEPTED_MAIN_BUNDLE_DATA if it is data.
      expect(unclassified).toEqual([]);
    });

    it('accepts data files only, never module code', () => {
      const accepted = closure.filter((file) => !isForced(file));

      expect(accepted.filter((file) => SOURCE_FILE.test(file))).toEqual([]);
      expect(accepted.length).toBeGreaterThan(0);
    });

    // A symlink at a data path could point at module code, so accepted data must be the file itself.
    it('accepts regular files only, not symlinks', () => {
      const accepted = [...new Set([...closure, ...rendererFiles])].filter(
        (file) => !isForced(file) && acceptedMainBundleData(file)
      );

      expect(accepted.filter((file) => !lstatSync(resolve(projectRoot, file)).isFile())).toEqual([]);
    });

    it.each(ACCEPTED_MAIN_BUNDLE_DATA)('still needs the accepted entry $pattern', ({ pattern }) => {
      expect(closure.some((file) => acceptedMainBundleData(file) === pattern && !isForced(file))).toBe(true);
    });

    it('forces a renderer file that a build alias points at', () => {
      const targets = Object.values(aliases)
        .map(fromRoot)
        .filter((target) => target.startsWith(`${RENDERER}/`) && kindOf(resolve(projectRoot, target)) === 'file');

      expect(targets.filter((file) => !isForced(file))).toEqual([]);
    });
  });

  describe('renderer paths named by the build configuration and the harness', () => {
    // Whole files that mention renderer paths but are not run by the full-verification jobs.
    const NOT_RUN_BY_FULL_VERIFICATION: Record<string, string> = {
      'scripts/check-i18n.js': 'run by the always-on I18n Check',
      'scripts/generate-i18n-types.js': 'developer tool that regenerates i18n-keys.d.ts',
    };
    // References that do not stand for every file below them, each reviewed by hand.
    const REVIEWED_REFERENCES = [
      {
        file: 'packages/desktop/electron.vite.config.ts',
        reference: `${RENDERER}/components/IconParkHOC`,
        reason: 'import the icon plugin writes into renderer .tsx files; the plugin is in the renderer build only',
      },
      ...[
        'scripts/studio-preview/providerHostSmoke.mjs',
        'scripts/studio-preview/providerRealSmoke.mjs',
        'scripts/outbound-audit/buildInstallerReportLocales.mjs',
      ].map((file) => ({
        file,
        reference: `${RENDERER}/services/i18n/locales`,
        reason: 'joined with <language>/settings.json, which is forced',
      })),
    ];

    const scanned = [
      'packages/desktop/electron.vite.config.ts',
      ...readdirSync(resolve(projectRoot, 'packages/desktop'))
        .filter((name) => name.startsWith('electron-builder'))
        .map((name) => `packages/desktop/${name}`),
      'package.json',
      '.github/workflows/pr-checks.yml',
      '.github/workflows/studio-outbound.yml',
      ...filesUnder('.github/actions/checkout-pr'),
      ...filesUnder('scripts'),
      ...filesUnder('packages/shared-scripts'),
      ...filesUnder('tests/studio-preview'),
      ...filesUnder('tests/outbound-audit'),
    ].filter((file) => TEXT_FILE.test(file) && !file.includes('/__pycache__/') && !file.includes('/node_modules/'));

    const isReviewed = (file: string, reference: string): boolean =>
      REVIEWED_REFERENCES.some((entry) => entry.file === file && entry.reference === reference);
    let spellings = new Map<string, string>();
    let references: Reference[] = [];
    let toCheck: Reference[] = [];

    beforeAll(() => {
      spellings = rendererSpellings(aliasTargets(config));
      references = scanned.flatMap((file) =>
        rendererReferences(readFileSync(resolve(projectRoot, file), 'utf8'), spellings).map((reference) => ({
          file,
          reference,
        }))
      );
      // The renderer root itself is the renderer build and its alias, not a single dependency.
      toCheck = references.filter(
        ({ file, reference }) =>
          reference !== RENDERER && !(file in NOT_RUN_BY_FULL_VERIFICATION) && !isReviewed(file, reference)
      );
    });

    it('recognises a renderer path under every alias that reaches the renderer tree', () => {
      expect([...spellings.keys()]).toEqual(expect.arrayContaining([RENDERER, '@renderer', '@/renderer']));
    });

    // The reviewer's case was the second line: a harness script importing through the `@/*` alias.
    it.each([
      "import url from '../../packages/desktop/src/renderer/utils/url';",
      "import reviewUrl from '@/renderer/utils/url';",
      "const { parseHttpUrl } = await import('@renderer/utils/url');",
    ])('finds the renderer path in: %s', (line) => {
      expect(rendererReferences(line, spellings)).toEqual([`${RENDERER}/utils/url`]);
    });

    it('finds no renderer path in an import of other code', () => {
      const text = "import a from '@/process/utils/url'; import b from '@/rendererless/x'; import c from '@common/x';";

      expect(rendererReferences(text, spellings)).toEqual([]);
    });

    it('derives the spelling of an alias that does not exist yet', () => {
      const next = rendererSpellings([
        ['~', 'packages'],
        ['@screens', `${RENDERER}/pages`],
        ['@host', 'packages/web-host/src'],
      ]);

      expect(rendererReferences("from '~/desktop/src/renderer/a'; from '@screens/guid'; from '@host/b'", next)).toEqual(
        [`${RENDERER}/a`, `${RENDERER}/pages/guid`]
      );
    });

    it('scans the build configuration and the harness scripts', () => {
      expect(scanned).toEqual(
        expect.arrayContaining([
          'packages/desktop/electron-builder.yml',
          'scripts/studio-preview/packaging/build.mjs',
          'scripts/outbound-audit/bundles/monacoSmoke.mjs',
        ])
      );
      expect(toCheck.map(({ reference }) => reference)).toContain(`${RENDERER}/assets/logos/*`);
    });

    it('forces every file a literal renderer path stands for', () => {
      const unforced = toCheck.flatMap(({ file, reference }) =>
        referencedFiles(reference)
          .filter((target) => !isForced(target))
          .map((target) => `${file} names ${reference}, which covers ${target}`)
      );

      // Add the path to FORCED_PATHS in .github/actions/full-verify-gate/gate.mjs, or review it above.
      expect(unforced).toEqual([]);
    });

    it('names only renderer paths that exist', () => {
      expect(toCheck.filter(({ reference }) => referencedFiles(reference).length === 0)).toEqual([]);
    });

    it('forces everything the build copies out of the renderer tree', () => {
      // Targets may be written relative to the project root or built from an absolute path.
      const sources = captured.staticCopy
        .flatMap(({ targets }) => targets.flatMap(({ src }) => src))
        .map((source) => fromRoot(resolve(projectRoot, source)))
        .filter((source) => source.startsWith(`${RENDERER}/`));

      expect(sources).toContain(`${RENDERER}/assets/logos/*`);
      expect(sources.filter((source) => referencedFiles(source).length === 0)).toEqual([]);
      expect(sources.flatMap(referencedFiles).filter((file) => !isForced(file))).toEqual([]);
    });

    it('names no renderer source path in the electron-builder configuration', () => {
      const packaged = scanned
        .filter((file) => file.startsWith('packages/desktop/electron-builder'))
        .flatMap((file) => stringsIn(yaml.load(readFileSync(resolve(projectRoot, file), 'utf8'))))
        .filter((value) => value.includes('src/renderer'));

      expect(packaged.flatMap(referencedFiles).filter((file) => !isForced(file))).toEqual([]);
      expect(packaged.filter((value) => referencedFiles(value).length === 0)).toEqual([]);
    });

    it('keeps no exception that the source no longer needs', () => {
      const stale = [
        ...Object.keys(NOT_RUN_BY_FULL_VERIFICATION).filter((file) => !references.some((found) => found.file === file)),
        ...REVIEWED_REFERENCES.filter(
          ({ file, reference }) => !references.some((found) => found.file === file && found.reference === reference)
        ).map(({ file, reference }) => `${file}: ${reference}`),
      ];

      expect(stale).toEqual([]);
    });
  });
});
