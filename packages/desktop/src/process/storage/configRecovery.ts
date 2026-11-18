import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { atomicReplace, atomicReplaceSync, cleanupStorageTemps } from './atomicFile';
import { trackPersistedWrite } from '../utils/persistOnQuit';

type RecoveryState = { preservedFile?: string; pendingNotice: boolean };

/** Keep recovery's update suppression independent of clear/setJson on the config. */
export function createConfigRecovery(config: string) {
  const marker = `${config}.recovery.json`;
  let showing = false;
  let noticeController: AbortController | undefined;
  let revision = 0;
  let writes: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const operation = writes.then(work);
    writes = operation.catch(() => {});
    return trackPersistedWrite(operation);
  };
  const state = (): RecoveryState | undefined => {
    cleanupStorageTemps(marker);
    try {
      const value = JSON.parse(readFileSync(marker, 'utf8')) as RecoveryState;
      return value && typeof value.pendingNotice === 'boolean' ? value : { pendingNotice: true };
    } catch (error) {
      // An unreadable marker still suppresses updates and asks for acknowledgement.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : { pendingNotice: true };
    }
  };
  return {
    mark(preservedFile: string): void {
      revision++;
      atomicReplaceSync(marker, JSON.stringify({ preservedFile, pendingNotice: true }));
    },
    active(): boolean {
      return state() !== undefined;
    },
    autoCheck(value: unknown): boolean {
      return state() === undefined && value !== false;
    },
    async finish(): Promise<void> {
      revision++;
      await enqueue(() => fs.rm(marker, { force: true }));
    },
    cancelNotice(): void {
      noticeController?.abort();
    },
    async showNotice(show: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
      const current = state();
      if (showing || !current?.pendingNotice) return;
      showing = true;
      const controller = new AbortController();
      noticeController = controller;
      const noticeRevision = revision;
      try {
        if (current.preservedFile)
          console.warn(`[Storage] Configuration recovery preserved file: ${current.preservedFile}`);
        await show(controller.signal);
        if (controller.signal.aborted) return;
        await enqueue(async () => {
          if (noticeRevision === revision && state() !== undefined) {
            await atomicReplace(marker, JSON.stringify({ ...current, pendingNotice: false }));
          }
        });
      } finally {
        showing = false;
        noticeController = undefined;
      }
    },
  };
}
