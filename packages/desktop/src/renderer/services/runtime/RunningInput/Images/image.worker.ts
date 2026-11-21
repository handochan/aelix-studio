import { encodeImage } from './codec';
import { readImageHeader } from './headers';
import { ImagePreparationError, type WorkerReply, type WorkerRequest } from './types';

const scope = globalThis as unknown as {
  addEventListener(type: 'message', handler: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(reply: WorkerReply): void;
};

function reply(message: WorkerReply): void {
  // eslint-disable-next-line unicorn/require-post-message-target-origin -- this is a dedicated worker, not a Window
  scope.postMessage(message);
}

scope.addEventListener('message', ({ data }) => {
  void (async () => {
    try {
      if (data.kind === 'inspect') {
        reply({ kind: 'inspected', header: await readImageHeader(data.source) });
      } else {
        const result = await encodeImage(data, (progress) => reply({ kind: 'progress', progress }));
        reply({ kind: 'encoded', result });
      }
    } catch (error) {
      reply({ kind: 'error', code: error instanceof ImagePreparationError ? error.code : 'invalid-image' });
    }
  })();
});
