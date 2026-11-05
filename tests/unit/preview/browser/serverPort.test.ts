/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildBrowserMcpEnv,
  buildMcpSpawnCommand,
  resolveBridgeToken,
  resolveBrowserUrl,
} from '@/process/resources/builtinMcp/browserServerPort';

describe('resolveBrowserUrl', () => {
  it('builds the URL from the port inherited down the process tree', () => {
    expect(resolveBrowserUrl({ env: { AIONUI_CDP_ACTIVE_PORT: '9230' } })).toBe('http://127.0.0.1:9230');
  });

  it('pins the host to loopback so the agent can never be aimed at a remote debugger', () => {
    expect(resolveBrowserUrl({ env: { AIONUI_CDP_ACTIVE_PORT: '9230' } })).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('rejects malformed or out-of-range ports', () => {
    for (const port of ['0', '-1', 'abc', '70000', '9230.5', '']) {
      expect(resolveBrowserUrl({ env: { AIONUI_CDP_ACTIVE_PORT: port } })).toBeNull();
    }
  });

  it('refuses to start when no port was inherited', () => {
    // 拿不到端口只有两种情况：用户关掉了 CDP，或不是从应用里启动的。
    // 两种都必须失败，不能去猜 —— 猜错会把 Agent 连到另一个实例的浏览器上。
    //
    // No inherited port means either the user disabled CDP or this was not launched
    // by the app. Both must fail rather than guess: guessing wrong would connect the
    // agent to a *different* instance's browser.
    expect(resolveBrowserUrl({ env: {} })).toBeNull();
  });

  it('ignores the user-facing AIONUI_CDP_PORT so a disabled setting cannot be re-enabled by inheritance', () => {
    // AIONUI_CDP_PORT 是「用户输入」,优先级高于配置文件。如果这里也读它,
    // 用户关掉 CDP 后点应用内重启,继承来的值会被当成「用户要求开启」,
    // 把刚保存的设置悄悄覆盖掉。两个用途必须分开。
    //
    // AIONUI_CDP_PORT is user input that outranks the config file. Reading it here
    // too would mean a disabled setting gets silently re-enabled after an in-app
    // restart, because the relaunched process inherits the value.
    expect(resolveBrowserUrl({ env: { AIONUI_CDP_PORT: '9230' } })).toBeNull();
  });
});

describe('resolveBridgeToken', () => {
  it('returns the token inherited from the process tree', () => {
    expect(resolveBridgeToken({ env: { AIONUI_CDP_BRIDGE_TOKEN: 'abc123' } })).toBe('abc123');
  });

  it('returns null when absent, so the caller refuses to start rather than connecting unauthenticated', () => {
    expect(resolveBridgeToken({ env: {} })).toBeNull();
  });

  it('treats a whitespace-only token as absent', () => {
    expect(resolveBridgeToken({ env: { AIONUI_CDP_BRIDGE_TOKEN: '   ' } })).toBeNull();
  });

  it('trims surrounding whitespace picked up from env plumbing', () => {
    expect(resolveBridgeToken({ env: { AIONUI_CDP_BRIDGE_TOKEN: ' tok \n' } })).toBe('tok');
  });
});

/**
 * 回归测试：issue #3883 —— Windows 上 aionui-browser MCP 完全起不来。
 *
 * npx 在 Windows 上是 npx.cmd，批处理文件没有终端无法自己执行，直接 spawn 会抛 EINVAL
 * （CVE-2024-27980 之后 Node 收紧了 .cmd 处理）。旧代码只是把可执行名换成 'npx.cmd'，
 * 而注释本身就写明「不走 shell 会失败」—— 换名恰恰就是那个失败写法。
 *
 * 这条分支此前没有任何测试覆盖（spawn 在模块顶层，单测 import 不了 browserServer.ts），
 * 所以缺陷得以合并进主干。现在命令行的组装被抽成纯函数，能直接钉住。
 *
 * Regression test for issue #3883: the aionui-browser MCP never starts on Windows. npx is
 * npx.cmd there, a batch file that cannot execute without a terminal, so spawning it directly
 * throws EINVAL (Node tightened .cmd handling after CVE-2024-27980). The old code merely
 * renamed the executable to 'npx.cmd' while its own comment said spawning without a shell
 * fails — the rename *is* the failing form.
 *
 * This branch had no test coverage (spawn runs at module scope, so browserServer.ts cannot be
 * imported by a unit test), which is how the defect reached main. The command assembly is now a
 * pure function and can be pinned directly.
 */
describe('local browser MCP launcher', () => {
  it.each(['C:\\Program Files\\node.exe', '/opt/studio/node'])(
    'uses the supplied Node binary directly: %s',
    (nodePath) => {
      const plan = buildMcpSpawnCommand({
        nodePath,
        scriptPath: '/bundle/chrome-devtools-mcp/build/src/index.js',
        browserUrl: 'http://127.0.0.1:61622',
      });
      expect(plan.command).toBe(nodePath);
      expect(plan.args).toEqual([
        '/bundle/chrome-devtools-mcp/build/src/index.js',
        '--no-usage-statistics',
        '--browser-url',
        'http://127.0.0.1:61622',
      ]);
      expect(plan.args).not.toContain('npx');
    }
  );
});

describe('Studio browser MCP network defaults', () => {
  it.each(['linux', 'darwin', 'win32'])('opts out of upstream metrics on %s', (platform) => {
    expect(
      buildMcpSpawnCommand({
        nodePath: platform === 'win32' ? 'C:\\node.exe' : '/node',
        scriptPath: '/bundle/index.js',
        browserUrl: 'http://127.0.0.1:61622',
      }).args
    ).toContain('--no-usage-statistics');
  });
  it('overrides metrics and npm background notices without changing the user registry', () => {
    const environment = buildBrowserMcpEnv({
      NPM_CONFIG_UPDATE_NOTIFIER: 'true',
      npm_config_audit: 'true',
      npm_config_registry: 'https://registry.internal',
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '',
    });
    expect(environment.NPM_CONFIG_UPDATE_NOTIFIER).toBeUndefined();
    expect(environment).toMatchObject({
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.internal',
    });
  });
  it('does not mutate inherited settings', () => {
    const source = { npm_config_update_notifier: 'true' };
    buildBrowserMcpEnv(source);
    expect(source.npm_config_update_notifier).toBe('true');
  });
});
