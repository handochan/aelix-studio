import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import { resolveImageGenerationMigrationConfig, runBackendMigrations } from '@/process/utils/runBackendMigrations';

const {
  batchImportServersMock,
  execFileMock,
  configFileGetMock,
  configFileSetMock,
  httpRequestMock,
  listServersMock,
  testMcpConnectionMock,
  updateServerMock,
  resolveBundledNodePathMock,
  builtinScriptPathMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  execFileMock: vi.fn(),
  configFileGetMock: vi.fn(),
  configFileSetMock: vi.fn(),
  httpRequestMock: vi.fn(),
  listServersMock: vi.fn(),
  testMcpConnectionMock: vi.fn(),
  updateServerMock: vi.fn(),
  resolveBundledNodePathMock: vi.fn(() => '/bundled/node'),
  builtinScriptPathMock: vi.fn((name: string) => `/mock/${name}.js`),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));
vi.mock('@process/backend/binaryResolver', () => ({ resolveBundledNodePath: resolveBundledNodePathMock }));

vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: httpRequestMock,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    listServers: { invoke: listServersMock },
    batchImportServers: { invoke: batchImportServersMock },
    updateServer: { invoke: updateServerMock },
    testMcpConnection: { invoke: testMcpConnectionMock },
  },
}));

vi.mock('@/common/config/configMigration', () => ({
  migrateConfigStorage: vi.fn().mockResolvedValue(undefined),
  migrateLegacyMcpConfigToDb: vi.fn().mockResolvedValue(undefined),
  migrateProviders: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/process/utils/initStorage', () => ({
  getBuiltinMcpScriptPath: builtinScriptPathMock,
}));

vi.mock('@/process/utils/migrateAssistants', () => ({
  migrateAssistantsToBackend: vi.fn().mockResolvedValue(true),
}));

const provider: IProvider = {
  id: 'provider-1',
  platform: 'gemini',
  name: 'Gemini',
  base_url: 'https://generativelanguage.googleapis.com',
  api_key: 'provider-key',
  models: ['gemini-image'],
  enabled: true,
};

const imageEnv = {
  [IMAGE_GEN_ENV_KEYS.providerId]: 'provider-1',
  [IMAGE_GEN_ENV_KEYS.platform]: 'gemini',
  [IMAGE_GEN_ENV_KEYS.baseUrl]: 'https://generativelanguage.googleapis.com',
  [IMAGE_GEN_ENV_KEYS.apiKey]: 'provider-key',
  [IMAGE_GEN_ENV_KEYS.model]: 'gemini-image',
};

const imageServer = (): IMcpServer => ({
  id: 'image-server-id',
  name: BUILTIN_IMAGE_GEN_NAME,
  description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
  enabled: true,
  builtin: true,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['/mock/builtin-mcp-image-gen.js'],
    env: imageEnv,
  },
  created_at: 1,
  updated_at: 1,
  original_json: JSON.stringify(
    {
      mcpServers: {
        [BUILTIN_IMAGE_GEN_NAME]: {
          command: 'node',
          args: ['/mock/builtin-mcp-image-gen.js'],
          env: imageEnv,
        },
      },
    },
    null,
    2
  ),
});

const configFile = {
  get: configFileGetMock,
  set: configFileSetMock,
};
const receiptKey = 'migration.chromeDevtoolsOwnedTransport_v1';
let chromeReceipt: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  chromeReceipt = undefined;
  resolveBundledNodePathMock.mockReturnValue('/bundled/node');
  builtinScriptPathMock.mockImplementation((name: string) => `/mock/${name}.js`);
  configFileGetMock.mockResolvedValue(undefined);
  configFileSetMock.mockResolvedValue(undefined);
  batchImportServersMock.mockImplementation(async ({ servers }) =>
    servers.map((server: IMcpServer) => ({
      ...server,
      id: `import-${server.name}`,
      created_at: 1,
      updated_at: 1,
    }))
  );
  updateServerMock.mockImplementation(async ({ id, data }) => ({
    ...imageServer(),
    id,
    name: id.includes('chrome') ? 'chrome-devtools' : BUILTIN_IMAGE_GEN_NAME,
    description: id.includes('chrome') ? 'Default MCP server: chrome-devtools' : imageServer().description,
    ...data,
  }));
  testMcpConnectionMock.mockResolvedValue({ success: false, error: 'Command not found: npx' });
  httpRequestMock.mockImplementation(async (method: string, path: string, payload?: Record<string, unknown>) => {
    if (method === 'PUT' && path === '/api/settings/client' && payload?.[receiptKey])
      chromeReceipt = payload[receiptKey];
    if (method === 'GET' && path === '/api/settings/client') {
      return {
        [receiptKey]: chromeReceipt,
        'tools.imageGenerationModel': {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
        },
      };
    }
    if (method === 'GET' && path === '/api/providers') {
      return [provider];
    }
    return undefined;
  });
});

describe('resolveImageGenerationMigrationConfig', () => {
  it('uses backend client preference when local config file no longer has the image model', () => {
    const backendConfig = {
      id: 'gemini',
      name: 'Gemini',
      platform: 'gemini',
      base_url: 'https://example.test',
      api_key: 'backend-key',
      use_model: 'gemini-image',
    };

    expect(resolveImageGenerationMigrationConfig({ 'tools.imageGenerationModel': backendConfig }, undefined)).toEqual(
      backendConfig
    );
  });
});

describe('runBackendMigrations', () => {
  it('does not write image generation business config back to local config storage', async () => {
    listServersMock.mockResolvedValue([imageServer()]);
    configFileGetMock.mockImplementation(async (key: string) => {
      if (key === 'tools.imageGenerationModel') {
        return {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
          switch: true,
        };
      }
      return undefined;
    });
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/settings/client') {
        return {};
      }
      if (method === 'GET' && path === '/api/providers') {
        return [provider];
      }
      return undefined;
    });

    await runBackendMigrations(configFile as never);

    expect(configFileSetMock).not.toHaveBeenCalledWith('tools.imageGenerationModel', expect.anything());
  });

  it('does not sync the built-in image MCP server when bootstrap makes no effective change', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([imageServer()]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'no',
      'no'
    );
  });

  it('does not sync agents when only the stored image MCP JSON representation differs', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([
      {
        ...imageServer(),
        original_json: '{"legacy":true}',
      },
    ]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).toHaveBeenCalledOnce();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'yes',
      'yes'
    );
  });
});

describe('disabled MCP startup preflight', () => {
  const chromeServer = (enabled: boolean): IMcpServer => ({
    ...imageServer(),
    id: 'chrome-id',
    name: 'chrome-devtools',
    enabled,
    transport: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    original_json: '{"mcpServers":{}}',
  });
  beforeEach(() => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: NodeJS.ErrnoException | null) => void
      ) => {
        callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      }
    );
  });
  it('migrates the owned remote package command to bundled Node without changing enablement', async () => {
    listServersMock.mockResolvedValue([chromeServer(false)]);
    await runBackendMigrations(configFile as never);
    expect(updateServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chrome-id',
        data: expect.objectContaining({
          transport: expect.objectContaining({
            command: '/bundled/node',
            args: expect.arrayContaining(['--no-usage-statistics']),
          }),
        }),
      })
    );
    expect(
      updateServerMock.mock.calls
        .filter(([request]) => request.id === 'chrome-id')
        .every(([request]) => request.data.enabled === undefined)
    ).toBe(true);
  });
  it('preserves customized package arguments', async () => {
    const server = chromeServer(false);
    server.transport = { type: 'stdio', command: 'npx', args: ['-y', 'custom-mcp@1.0', '--custom'] };
    listServersMock.mockResolvedValue([server]);
    await runBackendMigrations(configFile as never);
    expect(updateServerMock.mock.calls.some(([request]) => request.id === 'chrome-id')).toBe(false);
    expect(resolveBundledNodePathMock).not.toHaveBeenCalled();
  });
  const localArgs = () => [path.join('/mock', 'chrome-devtools-mcp/build/src/index.js'), '--no-usage-statistics'];
  async function importedChrome(): Promise<IMcpServer> {
    listServersMock.mockResolvedValue([]);
    await runBackendMigrations(configFile as never);
    const imported = (await batchImportServersMock.mock.results[0].value) as IMcpServer[];
    return imported.find((row) => row.name === 'chrome-devtools')!;
  }
  it('rebases an unchanged owned absolute row after moving the app and preserves enablement', async () => {
    const stored = await importedChrome();
    expect(chromeReceipt).toMatchObject({ schema: 1, id: stored.id });
    const oldReceipt = chromeReceipt;
    stored.enabled = true;
    listServersMock.mockResolvedValue([stored]);
    builtinScriptPathMock.mockImplementation((name: string) => `/moved/${name}.js`);
    resolveBundledNodePathMock.mockReturnValue('/moved/node');
    updateServerMock.mockClear();
    await runBackendMigrations(configFile as never);
    const request = updateServerMock.mock.calls.find(([value]) => value.id === stored.id)![0];
    expect(request.data).toMatchObject({
      transport: {
        command: '/moved/node',
        args: [path.join('/moved', 'chrome-devtools-mcp/build/src/index.js'), '--no-usage-statistics'],
      },
    });
    expect(request.data.enabled).toBeUndefined();
    expect(chromeReceipt).not.toEqual(oldReceipt);
    const rebased = await updateServerMock.mock.results[0].value;
    listServersMock.mockResolvedValue([rebased]);
    updateServerMock.mockClear();
    await runBackendMigrations(configFile as never);
    expect(updateServerMock.mock.calls.some(([value]) => value.id === stored.id)).toBe(false);
  });
  it.each(['command', 'path-node', 'args', 'env', 'original_json'])(
    'does not rebase an owned receipt after user edits %s',
    async (field) => {
      const stored = await importedChrome();
      const oldReceipt = chromeReceipt;
      if (stored.transport.type !== 'stdio') throw new Error('Expected stdio fixture');
      if (field === 'command') stored.transport.command = '/user/node';
      if (field === 'path-node') stored.transport.command = 'node';
      if (field === 'args') stored.transport.args = [...stored.transport.args!, '--custom'];
      if (field === 'env') stored.transport.env = { ...stored.transport.env, CUSTOM: 'yes' };
      if (field === 'original_json') stored.original_json = '{}';
      listServersMock.mockResolvedValue([stored]);
      updateServerMock.mockClear();
      resolveBundledNodePathMock.mockClear();
      await runBackendMigrations(configFile as never);
      expect(updateServerMock.mock.calls.some(([value]) => value.id === stored.id)).toBe(false);
      expect(resolveBundledNodePathMock).not.toHaveBeenCalled();
      expect(chromeReceipt).toEqual(oldReceipt);
    }
  );
  it.each([{ npm_config_registry: 'https://user.invalid' }, { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '0' }])(
    'preserves customized npx environment %j',
    async (env) => {
      const stored = chromeServer(false);
      if (stored.transport.type !== 'stdio') throw new Error('Expected stdio fixture');
      stored.transport.env = env;
      listServersMock.mockResolvedValue([stored]);
      await runBackendMigrations(configFile as never);
      expect(updateServerMock.mock.calls.some(([value]) => value.id === stored.id)).toBe(false);
      expect(resolveBundledNodePathMock).not.toHaveBeenCalled();
    }
  );
  it('does not replace an ownership receipt when the row update fails', async () => {
    const stored = await importedChrome();
    const oldReceipt = chromeReceipt;
    listServersMock.mockResolvedValue([stored]);
    resolveBundledNodePathMock.mockReturnValue('/moved/node');
    updateServerMock.mockRejectedValueOnce(new Error('Database unavailable'));
    await runBackendMigrations(configFile as never);
    expect(chromeReceipt).toMatchObject(oldReceipt as object);
    expect(chromeReceipt).toHaveProperty('pending');
  });
  it('does not claim an imported row that differs from the requested default', async () => {
    const stored = chromeServer(false);
    stored.transport = { type: 'stdio', command: '/user/node', args: localArgs() };
    listServersMock.mockResolvedValue([]);
    batchImportServersMock.mockResolvedValue([stored]);
    await runBackendMigrations(configFile as never);
    expect(chromeReceipt).not.toHaveProperty('id');
    updateServerMock.mockClear();
    resolveBundledNodePathMock.mockClear();
    listServersMock.mockResolvedValue([stored]);
    await runBackendMigrations(configFile as never);
    expect(updateServerMock.mock.calls.some(([value]) => value.id === stored.id)).toBe(false);
    expect(resolveBundledNodePathMock).not.toHaveBeenCalled();
  });
  it.each(['import', 'rebase'])('recovers %s when the final receipt write fails after saving the row', async (mode) => {
    let stored: IMcpServer | undefined;
    if (mode === 'rebase') {
      stored = await importedChrome();
      listServersMock.mockResolvedValue([stored]);
      resolveBundledNodePathMock.mockReturnValue('/moved/node');
    } else listServersMock.mockResolvedValue([]);
    const request = httpRequestMock.getMockImplementation()!;
    let failFinal = true;
    httpRequestMock.mockImplementation(async (method, route, payload) => {
      const value = payload?.[receiptKey] as { pending?: unknown } | undefined;
      if (failFinal && method === 'PUT' && value && !value.pending) throw new Error('Receipt unavailable');
      return request(method, route, payload);
    });
    updateServerMock.mockClear();
    batchImportServersMock.mockClear();
    await runBackendMigrations(configFile as never);
    if (mode === 'rebase') stored = await updateServerMock.mock.results[0].value;
    else
      stored = ((await batchImportServersMock.mock.results[0].value) as IMcpServer[]).find(
        (row) => row.name === 'chrome-devtools'
      );
    expect(chromeReceipt).toHaveProperty('pending');
    failFinal = false;
    listServersMock.mockResolvedValue([stored]);
    builtinScriptPathMock.mockImplementation((name: string) => `/another-move/${name}.js`);
    resolveBundledNodePathMock.mockReturnValue('/another-move/node');
    updateServerMock.mockClear();
    await runBackendMigrations(configFile as never);
    expect(updateServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: stored!.id,
        data: expect.objectContaining({ transport: expect.objectContaining({ command: '/another-move/node' }) }),
      })
    );
    expect(chromeReceipt).toMatchObject({ id: stored!.id });
    expect(chromeReceipt).not.toHaveProperty('pending');
  });
  it('retains the first legacy state if migration fails and retries it later', async () => {
    const stored = chromeServer(false);
    listServersMock.mockResolvedValue([stored]);
    updateServerMock.mockRejectedValueOnce(new Error('Row unavailable'));
    await runBackendMigrations(configFile as never);
    expect(chromeReceipt).toMatchObject({ id: stored.id, pending: { id: stored.id } });
    updateServerMock.mockClear();
    await runBackendMigrations(configFile as never);
    expect(updateServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: stored.id,
        data: expect.objectContaining({ transport: expect.objectContaining({ command: '/bundled/node' }) }),
      })
    );
    expect(chromeReceipt).not.toHaveProperty('pending');
  });
  it('does not change the row if writing its intent fails', async () => {
    const stored = await importedChrome();
    const oldReceipt = chromeReceipt;
    const request = httpRequestMock.getMockImplementation()!;
    httpRequestMock.mockImplementation(async (method, route, payload) => {
      if (method === 'PUT' && payload?.[receiptKey]) throw new Error('Intent unavailable');
      return request(method, route, payload);
    });
    listServersMock.mockResolvedValue([stored]);
    resolveBundledNodePathMock.mockReturnValue('/moved/node');
    updateServerMock.mockClear();
    await runBackendMigrations(configFile as never);
    expect(updateServerMock.mock.calls.some(([value]) => value.id === stored.id)).toBe(false);
    expect(chromeReceipt).toEqual(oldReceipt);
  });
  it('preserves an edited bare-node row when its ownership preferences cannot be read', async () => {
    const stored = await importedChrome();
    const oldReceipt = chromeReceipt;
    if (stored.transport.type !== 'stdio') throw new Error('Expected stdio fixture');
    stored.transport.command = 'node';
    const request = httpRequestMock.getMockImplementation()!;
    httpRequestMock.mockImplementation(async (method, route, payload) => {
      if (method === 'GET' && route === '/api/settings/client') throw new Error('Preferences unavailable');
      return request(method, route, payload);
    });
    listServersMock.mockResolvedValue([stored]);
    updateServerMock.mockClear();
    resolveBundledNodePathMock.mockClear();
    await runBackendMigrations(configFile as never);
    expect(updateServerMock.mock.calls.some(([value]) => value.id === stored.id)).toBe(false);
    expect(resolveBundledNodePathMock).not.toHaveBeenCalled();
    expect(chromeReceipt).toEqual(oldReceipt);
  });
  it('imports a fresh default with an absolute bundled Node command', async () => {
    listServersMock.mockResolvedValue([]);
    await runBackendMigrations(configFile as never);
    const imported = batchImportServersMock.mock.calls[0][0].servers as IMcpServer[];
    const server = imported.find((row) => row.name === 'chrome-devtools')!;
    expect(server.transport).toMatchObject({ command: '/bundled/node', args: localArgs() });
    expect(JSON.parse(server.original_json!).mcpServers['chrome-devtools'].command).toBe('/bundled/node');
  });
  it('upgrades the unchanged bundled-node default while preserving disabled state', async () => {
    const server = chromeServer(false);
    server.builtin = true;
    server.transport = {
      type: 'stdio',
      command: 'node',
      args: localArgs(),
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    };
    listServersMock.mockResolvedValue([server]);
    await runBackendMigrations(configFile as never);
    expect(updateServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chrome-id',
        data: expect.objectContaining({ transport: expect.objectContaining({ command: '/bundled/node' }) }),
      })
    );
    expect(
      updateServerMock.mock.calls
        .filter(([request]) => request.id === 'chrome-id')
        .every(([request]) => request.data.enabled === undefined)
    ).toBe(true);
  });
  it.each(['command', 'args', 'env', 'ownership'])('preserves a user-edited bundled row (%s)', async (change) => {
    const server = chromeServer(false);
    server.builtin = change !== 'ownership';
    server.transport = {
      type: 'stdio',
      command: change === 'command' ? '/custom/node' : 'node',
      args: [...localArgs(), ...(change === 'args' ? ['--custom'] : [])],
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1', ...(change === 'env' ? { CUSTOM: 'yes' } : {}) },
    };
    listServersMock.mockResolvedValue([server]);
    await runBackendMigrations(configFile as never);
    expect(updateServerMock.mock.calls.some(([request]) => request.id === 'chrome-id')).toBe(false);
    expect(resolveBundledNodePathMock).not.toHaveBeenCalled();
  });
  it('never probes or tests a disabled chrome-devtools server, even without system npx', async () => {
    listServersMock.mockResolvedValue([chromeServer(false)]);
    await runBackendMigrations(configFile as never);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
  });
  it('preserves preflight for a server explicitly enabled by the user', async () => {
    const server = chromeServer(true);
    listServersMock.mockResolvedValue([server]);
    await runBackendMigrations(configFile as never);
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(testMcpConnectionMock).toHaveBeenCalledWith(server);
  });
  it('keeps startup available if an explicitly enabled server cannot connect', async () => {
    const error = new Error('offline');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listServersMock.mockResolvedValue([chromeServer(true)]);
    testMcpConnectionMock.mockRejectedValueOnce(error);
    await runBackendMigrations(configFile as never);
    expect(warn).toHaveBeenCalledWith('[Migration] chrome-devtools MCP preflight failed', error);
    warn.mockRestore();
  });
});
