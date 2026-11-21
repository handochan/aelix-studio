import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeImage } from '@renderer/services/runtime/RunningInput/Images/codec';
import { hashImage } from '@renderer/services/runtime/RunningInput/Images/digest';
import {
  createImagePreparation,
  nativeLineBytes,
  nativeLineFits,
  verifyImageGrants,
} from '@renderer/services/runtime/RunningInput/Images';
import { readImageHeader } from '@renderer/services/runtime/RunningInput/Images/headers';
import { readReferencedImage } from '@renderer/services/runtime/RunningInput/Images/transfer';
import {
  ImagePreparationError,
  MAX_LINE_BYTES,
  type WorkerReply,
  type WorkerRequest,
} from '@renderer/services/runtime/RunningInput/Images/types';

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock('@renderer/services/FileService', () => ({ uploadFileViaHttp: upload }));

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64'
);
const original = new Blob(['source'], { type: 'image/png' });
const derivative = new Blob(['output'], { type: 'image/png' });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: string) => ({ sha256: sha(value), algorithm: 'js' as const, elapsedMs: 0 });
const ref = { kind: 'project', pe_id: 'fixture', relative_path: 'original.png' } as const;

class FixtureWorker {
  static instances: FixtureWorker[] = [];
  static silence = false;
  static budgetElapsed = 0;
  message: (event: { data: WorkerReply }) => void;
  addEventListener(type: string, handler: (event: { data: WorkerReply }) => void) {
    if (type === 'message') this.message = handler;
  }
  terminate = vi.fn();
  constructor() {
    FixtureWorker.instances.push(this);
  }
  postMessage(request: WorkerRequest) {
    if (FixtureWorker.silence) return;
    const header = { mime: 'image/png' as const, width: 8200, height: 1, orientation: 1 };
    const data: WorkerReply =
      request.kind === 'inspect'
        ? { kind: 'inspected', header }
        : {
            kind: 'encoded',
            result: {
              output: derivative,
              originalDigest: digest('source'),
              outputDigest: digest('output'),
              dimensions: { width: 2048, height: 1 },
              changed: true,
              secureContext: false,
              plannedBytes: 4096,
            },
          };
    setTimeout(() => this.message({ data }), FixtureWorker.budgetElapsed);
  }
}

function preparation(signal: AbortSignal = new AbortController().signal, count = 1) {
  vi.stubGlobal('Worker', FixtureWorker);
  return createImagePreparation({
    conversationId: 'conversation',
    model: { supported: true },
    signal,
    sources: Array.from({ length: count }, () => ({ blob: original, ref })),
    emptyNativeLine: (id) =>
      JSON.stringify({ id, message: '한"\n', images: Array.from({ length: count }, () => '') }) + '\n',
  });
}

afterEach(() => {
  FixtureWorker.instances = [];
  FixtureWorker.silence = false;
  FixtureWorker.budgetElapsed = 0;
  upload.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('image container and digest', () => {
  it('rejects a truncated container before any decode', async () => {
    await expect(readImageHeader(new Blob([png.subarray(0, 27)]))).rejects.toMatchObject({ code: 'invalid-image' });
  });

  it('rejects PNG data with an invalid chunk checksum', async () => {
    const corrupted = Uint8Array.from(png);
    corrupted[44] ^= 1;
    await expect(readImageHeader(new Blob([corrupted]))).rejects.toMatchObject({ code: 'invalid-image' });
  });

  it('falls back to the icon if a supplied thumbnail digest belongs to different bytes', async () => {
    const blob = new Blob([png], { type: 'image/png' });
    const header = await readImageHeader(blob);
    const request = {
      kind: 'encode' as const,
      source: blob,
      header,
      byteLimit: 3_750_000,
      edgeLimit: 8000,
      residentBytes: blob.size,
      forceJs: true,
    };
    const foreign = await encodeImage({ ...request, safePreview: { blob, forSha256: sha('different') } }, () => {});
    expect(foreign.preview).toBeUndefined();
    const matching = await encodeImage(
      {
        ...request,
        safePreview: { blob, forSha256: createHash('sha256').update(png).digest('hex') },
      },
      () => {}
    );
    expect(matching.preview?.blob).toBe(blob);
  });

  it('rejects a browser that returns PNG when JPEG encoding was requested', async () => {
    class Bitmap {
      width = 2;
      height = 1;
      close = vi.fn();
    }
    class Canvas {
      getContext() {
        return { setTransform() {}, drawImage() {} };
      }
      async convertToBlob() {
        return new Blob([png], { type: 'image/png' });
      }
    }
    const bitmap = new Bitmap();
    vi.stubGlobal('ImageBitmap', Bitmap);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    vi.stubGlobal('OffscreenCanvas', Canvas);
    await expect(
      encodeImage(
        {
          kind: 'encode',
          source: original,
          header: { mime: 'image/jpeg', width: 2, height: 1, orientation: 2 },
          byteLimit: 100,
          edgeLimit: 8000,
          residentBytes: original.size,
        },
        () => {}
      )
    ).rejects.toMatchObject({ code: 'codec-unavailable' });
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it('hashes bytes in chunks and matches an independent SHA-256', async () => {
    const input = new Uint8Array(600_001).fill(0xc7);
    const updates: number[] = [];
    const result = await hashImage(new Blob([input]), 'hash-original', ({ loaded }) => updates.push(loaded), true);
    expect(result.sha256).toBe(createHash('sha256').update(input).digest('hex'));
    expect(updates).toEqual([0, 262144, 524288, 600001]);
  });
});

describe('native JSONL limit', () => {
  it.each([-1, 0, 1])('includes UTF-8, escaping, per-image padding and newline at the limit %+d', (delta) => {
    const line = (message: string, data: string[]) => JSON.stringify({ message, data }) + '\n';
    const bytes = [1, 2, 4];
    const base64 = bytes.map((size) => Buffer.alloc(size, 0xab).toString('base64'));
    const seed = '한"\n';
    const remaining = MAX_LINE_BYTES + delta - Buffer.byteLength(line(seed, base64));
    const message = seed + 'a'.repeat(remaining);
    expect(nativeLineBytes(line(message, ['', '', '']), bytes)).toBe(MAX_LINE_BYTES + delta);
    expect(nativeLineFits(line(message, base64))).toBe(delta <= 0);
  });
});

describe('image preparation', () => {
  it('reuses the derivative ref and IDs on the same click and blocks a mismatched grant', async () => {
    upload.mockResolvedValue('/managed/derived.png');
    const job = preparation();
    const pending = job.prepare();
    const result = await pending;
    expect(job.prepare()).toBe(pending);
    expect(upload).toHaveBeenCalledExactlyOnceWith(
      expect.any(File),
      'conversation',
      undefined,
      undefined,
      expect.anything()
    );
    expect(result).toMatchObject({
      requestId: expect.stringMatching(/^[\da-f-]{14}7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
      images: [
        {
          ref: { kind: 'upload', path: '/managed/derived.png' },
          originalRef: ref,
          preview: { kind: 'icon', dimensions: { width: 2048, height: 1 } },
        },
      ],
    });
    const write = vi.fn();
    expect(() => write(verifyImageGrants(result, [{ byteLength: 6, sha256: sha('source') }]))).toThrow(
      'grant-mismatch'
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('does not re-upload after an ambiguous upload failure', async () => {
    upload.mockRejectedValue(new Error('/private/path'));
    const job = preparation();
    await expect(job.prepare()).rejects.toMatchObject({ code: 'upload-outcome-unknown' });
    await expect(job.prepare()).rejects.toMatchObject({ code: 'upload-outcome-unknown' });
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('keeps one network transfer progressing across its own upload and response clocks', async () => {
    vi.useFakeTimers();
    upload.mockImplementation(
      (_file, _conversation, _percent, _name, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
          setTimeout(() => options.onTransfer('upload', 3, 6), 20_000);
          setTimeout(() => options.onTransfer('upload-response', 6, 6), 40_000);
          setTimeout(() => resolve('/managed/derived.png'), 60_000);
        })
    );
    const result = preparation().prepare();
    await vi.advanceTimersByTimeAsync(60_010);
    await expect(result).resolves.toMatchObject({ images: [{ ref: { kind: 'upload' } }] });
  });

  it('cancels the upload and ignores its delayed response after a draft replacement', async () => {
    let uploadSignal: AbortSignal;
    upload.mockImplementation(
      (_file, _conversation, _percent, _name, options) =>
        new Promise((_resolve, reject) => {
          uploadSignal = options.signal;
          uploadSignal.addEventListener('abort', () => reject(uploadSignal.reason));
        })
    );
    const job = preparation();
    const pending = job.prepare();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    job.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(uploadSignal.aborted).toBe(true);
    await expect(job.prepare()).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('terminates the worker on Stop or draft replacement', async () => {
    const lifetime = new AbortController();
    FixtureWorker.silence = true;
    const job = preparation(lifetime.signal);
    const pending = job.prepare();
    await vi.waitFor(() => expect(FixtureWorker.instances).toHaveLength(1));
    lifetime.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(FixtureWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });

  it('times out an unresponsive worker after 5 seconds', async () => {
    vi.useFakeTimers();
    FixtureWorker.silence = true;
    const job = preparation();
    const failed = expect(job.prepare()).rejects.toMatchObject({ code: 'codec-timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(FixtureWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(upload).not.toHaveBeenCalled();
  });

  it('spends the aggregate 15-second worker budget across images', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    FixtureWorker.budgetElapsed = 2300;
    const job = preparation(undefined, 4);
    const failed = expect(job.prepare()).rejects.toMatchObject({ code: 'codec-timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('reference download', () => {
  const metadata = (size: number, last_modified = 1) =>
    Response.json({ success: true, data: { size, path: '/owner/original.png', last_modified } });

  it('aborts on the 30-second idle boundary', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
          })
      )
    );
    const read = readReferencedImage(ref, new AbortController().signal, () => {});
    const failed = expect(read).rejects.toMatchObject({ code: 'network-idle' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
  });

  it('consumes a progressing download past the codec deadline and checks metadata again', async () => {
    vi.useFakeTimers();
    let body: ReadableStreamDefaultController;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          body = controller;
        },
      })
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(metadata(2))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(metadata(2));
    vi.stubGlobal('fetch', fetch);
    const read = readReferencedImage(ref, new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(20_000);
    body.enqueue(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(20_000);
    body.enqueue(Uint8Array.of(2));
    body.close();
    expect(new Uint8Array(await (await read).arrayBuffer())).toEqual(Uint8Array.of(1, 2));
    expect(String(fetch.mock.calls[1][0])).toContain('/api/fs/stream?kind=project&pe_id=fixture');
  });

  it('rejects a changed file even when the stream has the expected length', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(metadata(2))
        .mockResolvedValueOnce(new Response('xy'))
        .mockResolvedValueOnce(metadata(2, 2))
    );
    await expect(readReferencedImage(ref, new AbortController().signal, () => {})).rejects.toEqual(
      new ImagePreparationError('source-changed')
    );
  });
});
