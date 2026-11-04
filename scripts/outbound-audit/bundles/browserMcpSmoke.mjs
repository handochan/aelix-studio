/** Start the bundled stdio wrapper with no PATH tools, initialize and list tools. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [script, output] = process.argv.slice(2);
assert.ok(script && output, 'Bundled wrapper and report paths are required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-offline-mcp-'));
const env = {
  PATH: path.join(root, 'no-tools'),
  HOME: root,
  USERPROFILE: root,
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  AIONUI_CDP_ACTIVE_PORT: '9',
  AIONUI_CDP_BRIDGE_TOKEN: 'synthetic-offline-control-token',
  npm_config_registry: 'https://registry.invalid',
  NPM_CONFIG_UPDATE_NOTIFIER: 'true',
};
const child = spawn(process.execPath, [path.resolve(script)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
let pending = '';
let diagnostics = '';
const replies = new Map();
const waiters = new Map();
child.stdout.on('data', (chunk) => {
  pending += chunk.toString();
  while (pending.includes('\n')) {
    const offset = pending.indexOf('\n');
    const line = pending.slice(0, offset);
    pending = pending.slice(offset + 1);
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        replies.set(message.id, message);
        waiters.get(message.id)?.();
      }
    } catch {
      child.kill();
    }
  }
});
child.stderr.on('data', (chunk) => {
  diagnostics += chunk.toString();
});
const request = async (id, method, params) => {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  if (!replies.has(id))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bundled MCP response timeout')), 15000);
      waiters.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!replies.has(id)) {
          clearTimeout(timer);
          reject(new Error('Bundled MCP exited: ' + code));
        }
      });
    });
  const reply = replies.get(id);
  assert.ok(!reply.error, 'MCP request failed');
  return reply.result;
};
try {
  const init = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'offline-fixture', version: '1.0.0' },
  });
  assert.equal(init.serverInfo.version, '0.16.0');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request(2, 'tools/list', {});
  assert.ok(listed.tools.some((tool) => tool.name === 'navigate_page'));
  assert.ok(listed.tools.some((tool) => tool.name === 'list_pages'));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(
    output,
    JSON.stringify({
      status: 'passed',
      version: init.serverInfo.version,
      toolCount: listed.tools.length,
      pathTools: false,
      usageStatisticsDisabled: diagnostics.includes('turning off usage statistics'),
    }) + '\n'
  );
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('MCP exit ' + code))));
    setTimeout(() => {
      child.kill();
      reject(new Error('MCP shutdown timeout'));
    }, 5000).unref();
  });
} finally {
  if (child.exitCode === null) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
