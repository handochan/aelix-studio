import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { registerAelix, type StudioApi } from './registerAelix';

/** Register through the existing local backend API before releasing the startup gate. */
export async function bootstrapAelixStudio(port: number): Promise<void> {
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  const runtime = path.join(resources, 'bundled-aelix', `${process.platform}-${process.arch}`);
  const command = path.join(runtime, 'bin', 'aelix-acp');
  fs.accessSync(command, fs.constants.X_OK);
  async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-aionui-internal': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
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
  await registerAelix(api, command, path.join(app.getPath('userData'), 'aelix-acp'));
}
