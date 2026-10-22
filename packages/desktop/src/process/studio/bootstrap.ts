import { app } from 'electron';
import path from 'node:path';
import { bootstrapStudioRuntime } from './runtime';

/** Register through the existing local backend API before releasing the startup gate. */
export async function bootstrapAelixStudio(port: number): Promise<void> {
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
  await bootstrapStudioRuntime(port, resources, app.getPath('userData'));
}
