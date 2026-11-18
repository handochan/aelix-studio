#!/usr/bin/env bun
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Reset the standalone WebUI password using the host's offline user command.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const BACKEND_BINARY = process.platform === 'win32' ? 'aelix-studio-host.exe' : 'aelix-studio-host';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith('--') ? next : undefined;
}

/**
 * Same resolution as scripts/webui.ts:resolveBackendDataDir — keep both in sync
 * so `bun run webui` and `bun run resetpass` always target the same SQLite DB.
 * See the comment there for why the default is `~/.aionui-web*` (not `~/.aionui*`).
 */
function resolveWorkDir(): string {
  const override = getFlag('--data-dir') ?? process.env.AIONUI_DATA_DIR;
  if (override && override.trim().length > 0) {
    const resolved = path.resolve(override);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  const suffix =
    process.env.NODE_ENV === 'production' ? '' : process.env.AIONUI_MULTI_INSTANCE === '1' ? '-dev-2' : '-dev';
  const dir = path.join(os.homedir(), `.aionui-web${suffix}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveBackendBinary(): string {
  if (process.env.AIONUI_BACKEND_BIN) return process.env.AIONUI_BACKEND_BIN;

  const bundledBase = process.env.AIONUI_BACKEND_BUNDLED_DIR ?? path.join(repoRoot, 'resources', 'bundled-aioncore');
  const runtimeKey = `${process.platform}-${process.arch}`;
  const bundled = path.join(bundledBase, runtimeKey, BACKEND_BINARY);
  if (fs.existsSync(bundled)) return bundled;

  try {
    const cmd = process.platform === 'win32' ? `where ${BACKEND_BINARY}` : `which ${BACKEND_BINARY}`;
    const found = execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    // fall through
  }

  throw new Error(
    `Cannot find "${BACKEND_BINARY}". Set AIONUI_BACKEND_BIN, put it on PATH, or place it at ${bundled}.`
  );
}

const binary = resolveBackendBinary();
const args = ['--data-dir', resolveWorkDir(), 'user', 'set-password', '--require-stopped'];
if (process.argv.includes('--password-stdin')) args.push('--password-stdin');
const result = spawnSync(binary, args, { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
