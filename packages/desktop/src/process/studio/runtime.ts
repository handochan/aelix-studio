import fs from 'node:fs';
import path from 'node:path';
import { registerAelix, type StudioApi, type StudioCommand } from './registerAelix';

/** Use the upstream managed Node resolver; executable and Python arguments never pass through a shell. */
export function getStudioCommand(
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch
): StudioCommand {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const runtime = paths.join(resourcesPath, 'bundled-aelix', `${platform}-${arch}`);
  return {
    command: 'node',
    args: [paths.join(runtime, 'launch.cjs'), 'acp'],
  };
}

/** Seed the bundled engine through the existing local API for desktop and standalone WebUI. */
export async function bootstrapStudioRuntime(port: number, resourcesPath: string, dataPath: string): Promise<void> {
  const launch = getStudioCommand(resourcesPath);
  const runtime = path.dirname(launch.args[0]);
  fs.accessSync(
    path.join(runtime, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3'),
    fs.constants.X_OK
  );
  for (const file of ['launch.cjs', 'launch.py', 'site/aelix_analytics/extension.py']) {
    fs.accessSync(path.join(runtime, file), fs.constants.R_OK);
  }
  async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-aionui-internal': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 60_000),
    });
    if (!response.ok) {
      throw Object.assign(new Error(`Aelix registration ${route}: HTTP ${response.status}`), {
        status: response.status,
      });
    }
    const json = (await response.json()) as { data?: T };
    return ('data' in json ? json.data : json) as T;
  }
  const api: StudioApi = {
    listAgents: () => request('/api/agents/management'),
    createAgent: (body) => request('/api/agents/custom', 'POST', body),
    updateAgent: (id, body) => request(`/api/agents/custom/${encodeURIComponent(id)}`, 'PUT', body),
  };
  await registerAelix(api, launch, path.join(dataPath, 'aelix-acp'));
}
