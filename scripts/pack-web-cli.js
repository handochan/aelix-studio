#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { prepareAioncore } = require('../packages/shared-scripts/src/prepare-aioncore.js');
const { resolveAioncoreVersion } = require('./resolveAioncoreVersion.js');

const projectRoot = path.resolve(__dirname, '..');
const platform = process.env.PACK_PLATFORM || process.platform;
const arch = process.env.PACK_ARCH || process.arch;
const version = require('../package.json').version;

// Normalize platform/arch names for tarball filename
const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'win' };
const archMap = { arm64: 'arm64', x64: 'x86_64', ia32: 'x86' };
const normalizedPlatform = platformMap[platform] || platform;
const normalizedArch = archMap[arch] || arch;

const tarballName = `aelix-studio-web-${version}-${normalizedPlatform}-${normalizedArch}.tar.gz`;
const distDir = path.join(projectRoot, 'dist-web-cli');
const tarballPath = path.join(distDir, tarballName);

console.log(`Packing web-cli for ${platform}-${arch}...`);

// 1. Prepare bundled-aioncore
console.log('1. Preparing aioncore...');
prepareAioncore({
  projectRoot,
  platform,
  arch,
  version: resolveAioncoreVersion(projectRoot),
});

// 2. Create staging dir
console.log('3. Creating staging dir...');
const stagingDir = path.join(distDir, 'staging');
fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const tarballContentDir = path.join(stagingDir, 'aelix-studio-web');
fs.mkdirSync(tarballContentDir, { recursive: true });

// 4. Compile web-cli into a standalone executable with bun
// Produces a single binary (~100MB) that bundles bun runtime + all deps, so
// the tarball has no node_modules and the user needs no Node installation.
console.log('4. Compiling web-cli into standalone executable...');
// Map our platform/arch to bun's --target naming
const bunTargetPlatform = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform] || platform;
const bunTargetArch = { arm64: 'arm64', x64: 'x64', ia32: 'x64' }[arch] || arch;
const bunTarget = `bun-${bunTargetPlatform}-${bunTargetArch}`;
const executableName = platform === 'win32' ? 'aelix-studio-web.exe' : 'aelix-studio-web';
const executablePath = path.join(tarballContentDir, executableName);
const webCliEntry = path.join(projectRoot, 'packages/web-cli/src/index.ts');
execSync(`bun build --compile --target=${bunTarget} --outfile="${executablePath}" "${webCliEntry}"`, {
  cwd: projectRoot,
  stdio: 'inherit',
});
console.log(`  → ${executablePath}`);

// The standalone CLI reads the version from this file beside the executable.
fs.writeFileSync(path.join(tarballContentDir, 'package.json'), JSON.stringify({ version }) + '\n');
if (platform === 'linux') {
  fs.copyFileSync(
    path.join(projectRoot, 'packages/web-cli/aelix-studio-web.service'),
    path.join(tarballContentDir, 'aelix-studio-web.service')
  );
}

// 6. Copy static files (SPA) from desktop renderer build output
// Note: electron-vite writes to the repo-root `out/`, NOT packages/desktop/out/
console.log('6. Copying static files...');
const rendererOutDir = path.join(projectRoot, 'out/renderer');
const staticDest = path.join(tarballContentDir, 'static');
if (fs.existsSync(rendererOutDir)) {
  fs.cpSync(rendererOutDir, staticDest, { recursive: true });
} else {
  throw new Error(`Desktop renderer output not found at ${rendererOutDir}. Run bunx electron-vite build first.`);
}

// 7. Copy bundled-aioncore
const backendSrc = path.join(projectRoot, 'resources/bundled-aioncore', `${platform}-${arch}`);
const backendDest = path.join(tarballContentDir, 'bundled-aioncore', `${platform}-${arch}`);
if (!fs.existsSync(backendSrc)) {
  throw new Error(`Backend bundle dir missing at ${backendSrc}. Ensure prepareAioncore succeeded.`);
}
fs.mkdirSync(path.dirname(backendDest), { recursive: true });
fs.cpSync(backendSrc, backendDest, { recursive: true });

// 8. Create tarball
fs.mkdirSync(distDir, { recursive: true });
execSync(`tar -czf ${path.basename(tarballPath)} -C ${stagingDir} aelix-studio-web`, {
  cwd: path.dirname(tarballPath),
  stdio: 'inherit',
});

console.log(`✅ Tarball created: ${tarballPath}`);

// 9. Generate SHA256 checksum (cross-platform: use Node's crypto, not `shasum`)
const checksumPath = `${tarballPath}.sha256`;
const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(tarballPath));
const digest = hash.digest('hex');
// Match shasum format: "<hash>  <filename>\n"
fs.writeFileSync(checksumPath, `${digest}  ${path.basename(tarballPath)}\n`);
console.log(`✅ Checksum created: ${checksumPath}`);

console.log('Done!');
