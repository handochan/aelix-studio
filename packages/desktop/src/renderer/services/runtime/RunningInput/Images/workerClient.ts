import { ImagePreparationError, type HashProgress, type WorkerReply, type WorkerRequest } from './types';

type Result = Extract<WorkerReply, { kind: 'inspected' | 'encoded' }>;

/** Each command owns its worker and releases all native state on completion or cancellation. */
export function runImageWorker(
  request: WorkerRequest,
  signal: AbortSignal,
  budget: number,
  report: (progress: HashProgress) => void
): Promise<{ result: Result; elapsedMs: number }> {
  signal.throwIfAborted();
  if (budget <= 0) throw new ImagePreparationError('codec-timeout');
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let worker: Worker;
    try {
      worker = new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new ImagePreparationError('worker-failed'));
      return;
    }
    let finished = false;
    const finish = () => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (reason: unknown) => {
      if (finished) return;
      finish();
      reject(reason);
    };
    const abort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(new ImagePreparationError('codec-timeout')), budget);
    signal.addEventListener('abort', abort, { once: true });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      fail(new ImagePreparationError('worker-failed'));
    });
    worker.addEventListener('messageerror', () => fail(new ImagePreparationError('worker-failed')));
    worker.addEventListener('message', ({ data }: MessageEvent<WorkerReply>) => {
      if (finished) return;
      const elapsedMs = performance.now() - started;
      if (elapsedMs >= budget) {
        fail(new ImagePreparationError('codec-timeout'));
      } else if (data.kind === 'progress') {
        report(data.progress);
      } else if (data.kind === 'error') {
        fail(new ImagePreparationError(data.code));
      } else {
        finish();
        resolve({ result: data, elapsedMs });
      }
    });
    try {
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- this is a dedicated worker, not a Window
      worker.postMessage(request);
    } catch {
      fail(new ImagePreparationError('worker-failed'));
    }
  });
}
