import { createHash } from 'node:crypto';
import { constants, crc32, deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeImage } from '@renderer/services/runtime/RunningInput/Images/codec';
import { hashImage } from '@renderer/services/runtime/RunningInput/Images/digest';
import {
  createImagePreparation,
  nativeLineBytes,
  nativeLineFits,
  verifyImageGrants,
} from '@renderer/services/runtime/RunningInput/Images';
import type { ImageMime } from '@renderer/services/runtime/RunningInput/Images';
import { findZlibEnd } from '@renderer/services/runtime/RunningInput/Images/Png/deflate';
import { verifyPngData } from '@renderer/services/runtime/RunningInput/Images/Png';
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
function pngChunk(type: string, data: Uint8Array) {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length);
  result.write(type, 4);
  result.set(data, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function pngWithIdat(payload: Uint8Array, trailingIdat?: Uint8Array, following: Buffer[] = []): Blob {
  return new Blob([
    png.subarray(0, 33),
    pngChunk('IDAT', payload),
    ...(trailingIdat ? [pngChunk('IDAT', trailingIdat)] : []),
    ...following,
    png.subarray(-12),
  ]);
}

const original = new Blob(['source'], { type: 'image/png' });
const jpegOriginal = new Blob(['jpeg']);
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
    const mime = request.source === jpegOriginal ? 'image/jpeg' : 'image/png';
    const header = { mime, width: 8200, height: 1, orientation: 1 } as const;
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

  it.each([
    ['corrupted zlib with correct PNG CRC', Uint8Array.of(0xff, 1, 2, 3, 4)],
    ['short zlib output', deflateSync(Uint8Array.of(0, 0))],
    ['excess zlib output', deflateSync(new Uint8Array(6))],
    ['invalid row filter', deflateSync(Uint8Array.of(5, 0, 0, 0, 0))],
  ])('rejects %s without opening a bitmap', async (_case, payload) => {
    const blob = pngWithIdat(payload);
    const header = await readImageHeader(blob);
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    await expect(
      encodeImage(
        {
          kind: 'encode',
          source: blob,
          header,
          byteLimit: 3_750_000,
          edgeLimit: 8000,
          residentBytes: blob.size,
        },
        () => {}
      )
    ).rejects.toMatchObject({ code: 'invalid-image' });
    expect(bitmap).not.toHaveBeenCalled();
  });

  it('validates one zlib stream split across consecutive IDAT chunks', async () => {
    const zlib = deflateSync(new Uint8Array(5));
    const blob = pngWithIdat(zlib.subarray(0, 1), zlib.subarray(1));
    const header = await readImageHeader(blob);
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    await expect(
      encodeImage(
        {
          kind: 'encode',
          source: blob,
          header,
          byteLimit: 3_750_000,
          edgeLimit: 8000,
          residentBytes: blob.size,
        },
        () => {}
      )
    ).resolves.toMatchObject({ changed: false });
    expect(bitmap).not.toHaveBeenCalled();
  });

  it.each([
    ['Windows-style zero padding', Buffer.alloc(16)],
    ['opaque padding', Buffer.from([0xd4, 0, 0x78, 0x9c, 0x04, 0xee])],
  ])('preserves %s after a split zlib trailer and before a legal ancillary chunk', async (_label, padding) => {
    const zlib = deflateSync(new Uint8Array(5));
    const split = zlib.length - 2;
    const blob = pngWithIdat(zlib.subarray(0, split), Buffer.concat([zlib.subarray(split), padding]), [
      pngChunk('tEXt', Buffer.from('Description\0Screenshot fixture')),
    ]);
    const header = await readImageHeader(blob);
    const bitmap = vi.fn();
    vi.stubGlobal('createImageBitmap', bitmap);
    const result = await encodeImage(
      {
        kind: 'encode',
        source: blob,
        header,
        byteLimit: 3_750_000,
        edgeLimit: 8000,
        residentBytes: blob.size,
      },
      () => {}
    );
    expect(result.changed).toBe(false);
    expect(Buffer.from(await result.output.arrayBuffer()).equals(Buffer.from(await blob.arrayBuffer()))).toBe(true);
    expect(bitmap).not.toHaveBeenCalled();
  });

  it('checks Adler-32 after removing padding from the final IDAT', async () => {
    const zlib = deflateSync(new Uint8Array(5));
    zlib[zlib.length - 1] ^= 1;
    await expect(verifyPngData(pngWithIdat(Buffer.concat([zlib, Buffer.alloc(16)])))).rejects.toMatchObject({
      code: 'invalid-image',
    });
  });

  it('rejects a padded stream that contains an invalid scanline filter', async () => {
    const padded = Buffer.concat([deflateSync(Uint8Array.of(5, 0, 0, 0, 0)), Buffer.alloc(16)]);
    await expect(verifyPngData(pngWithIdat(padded))).rejects.toMatchObject({ code: 'invalid-image' });
  });

  it('detects animation even after a padded IDAT', async () => {
    const padded = Buffer.concat([deflateSync(new Uint8Array(5)), Buffer.alloc(16)]);
    await expect(
      readImageHeader(pngWithIdat(padded, undefined, [pngChunk('acTL', Buffer.alloc(8))]))
    ).rejects.toMatchObject({ code: 'unsupported-format' });
  });

  it('rejects an oversized chunk declaration after a padded IDAT', async () => {
    const malformed = pngChunk('tEXt', Buffer.from('Source\0Fixture'));
    malformed.writeUInt32BE(0x80000000, 0);
    const padded = Buffer.concat([deflateSync(new Uint8Array(5)), Buffer.alloc(16)]);
    await expect(readImageHeader(pngWithIdat(padded, undefined, [malformed]))).rejects.toMatchObject({
      code: 'invalid-image',
    });
  });

  it('keeps a verified derivative when thumbnail canvas initialization fails', async () => {
    class Bitmap {
      close = vi.fn();
      constructor(
        readonly width: number,
        readonly height: number
      ) {}
    }
    class Canvas {
      static initialized = 0;
      getContext() {
        return ++Canvas.initialized === 1 ? { setTransform() {}, drawImage() {} } : null;
      }
      async convertToBlob() {
        return new Blob([png], { type: 'image/png' });
      }
    }
    const source = new Blob([png], { type: 'image/png' });
    const decoded = new Bitmap(1, 1);
    const verified = new Bitmap(1, 1);
    vi.stubGlobal('ImageBitmap', Bitmap);
    vi.stubGlobal('OffscreenCanvas', Canvas);
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValueOnce(decoded).mockResolvedValueOnce(verified));
    const result = await encodeImage(
      {
        kind: 'encode',
        source,
        header: { mime: 'image/png', width: 1, height: 1, orientation: 2 },
        residentBytes: source.size,
        byteLimit: 1000,
        edgeLimit: 100,
        forceJs: true,
      },
      () => {}
    );
    expect(result).toMatchObject({ changed: true, dimensions: { width: 1, height: 1 }, preview: undefined });
    expect(verified.close).toHaveBeenCalledOnce();
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

describe('zlib frame length', () => {
  it.each([
    { name: 'stored', options: { level: 0 }, kind: 0 },
    { name: 'fixed', options: { strategy: constants.Z_FIXED }, kind: 1 },
    { name: 'dynamic', options: { level: 9 }, kind: 2 },
  ])('finds the checksum end across $name blocks and IDAT boundaries', ({ options, kind }) => {
    const data = Buffer.from('Some different screenshot intensities 0123456789 '.repeat(2000));
    const frame = deflateSync(data, options);
    expect((frame[2] >> 1) & 3).toBe(kind);
    const input = Uint8Array.from(Buffer.concat([frame, Buffer.alloc(4096, 0xa3)]));
    function* split() {
      for (let offset = 0; offset < input.length; offset += 11) yield input.subarray(offset, offset + 11);
    }
    expect(findZlibEnd(split(), data.length)).toBe(frame.length);
  });

  it('rejects an invalid stored block length complement', () => {
    const frame = Uint8Array.from(deflateSync(Buffer.from('source'), { level: 0 }));
    frame[5] ^= 1;
    expect(() => findZlibEnd([frame].values(), 6)).toThrow('invalid-image');
  });
});

describe('native JSONL limit', () => {
  it.each([-1, 0, 1])('prices identified MIME, JSON escaping, base64 and newline at the limit %+d', async (delta) => {
    const mimes: ImageMime[] = ['image/jpeg', 'image/png'];
    const base64 = Buffer.from('output').toString('base64');
    const line = (id: string, message: string, mimeTypes: readonly ImageMime[], data: string) =>
      JSON.stringify({
        type: 'steer',
        id,
        message,
        images: mimeTypes.map((mime_type) => ({ type: 'image', mime_type, data })),
      }) + '\n';
    const id = '00000000-0000-7000-8000-000000000000';
    const seed = '한"\n';
    const remaining = MAX_LINE_BYTES + delta - Buffer.byteLength(line(id, seed, mimes, base64));
    const message = seed + 'a'.repeat(remaining);
    const native = line(id, message, mimes, base64);
    const template = vi.fn((requestId: string, identified: readonly ImageMime[]) =>
      line(requestId, message, identified, '')
    );
    vi.stubGlobal('Worker', FixtureWorker);
    upload.mockResolvedValue('/managed/derived');
    const prepared = createImagePreparation({
      signal: new AbortController().signal,
      conversationId: 'conversation',
      sources: [{ blob: jpegOriginal }, { blob: original }],
      model: { supported: true },
      emptyNativeLine: template,
    }).prepare();
    if (delta <= 0) {
      await expect(prepared).resolves.toMatchObject({ estimatedLineBytes: MAX_LINE_BYTES + delta });
    } else {
      await expect(prepared).rejects.toMatchObject({ code: 'limits' });
      expect(upload).not.toHaveBeenCalled();
    }
    expect(template).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^[\da-f-]{36}$/), mimes);
    expect(nativeLineFits(native)).toBe(delta <= 0);
  });

  it('counts base64 padding separately for each file', () => {
    expect(nativeLineBytes('\n', [1, 2, 4])).toBe(17);
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
    let reply: (path: string) => void;
    upload
      .mockImplementationOnce(
        (_file, _conversation, _percent, _name, options) =>
          new Promise((resolve) => {
            uploadSignal = options.signal;
            reply = resolve;
          })
      )
      .mockResolvedValueOnce('/managed/next.png');
    const job = preparation();
    const pending = job.prepare();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    job.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(uploadSignal.aborted).toBe(true);
    reply('/managed/late.png');
    await expect(preparation().prepare()).resolves.toMatchObject({ images: [{ ref: { path: '/managed/next.png' } }] });
    await expect(job.prepare()).rejects.toMatchObject({ code: 'cancelled' });
    expect(upload).toHaveBeenCalledTimes(2);
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

  it('starts a new 30-second idle window when the download headers arrive', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(metadata(2))
        .mockImplementationOnce(
          (_url, { signal }) =>
            new Promise((resolve) =>
              setTimeout(() => {
                resolve(
                  new Response(
                    new ReadableStream({
                      start(controller) {
                        const timer = setTimeout(() => {
                          controller.enqueue(Uint8Array.of(1, 2));
                          controller.close();
                        }, 29_900);
                        signal.addEventListener(
                          'abort',
                          () => {
                            clearTimeout(timer);
                            controller.error(signal.reason);
                          },
                          { once: true }
                        );
                      },
                    })
                  )
                );
              }, 29_900)
            )
        )
        .mockResolvedValueOnce(metadata(2))
    );
    const result = readReferencedImage(ref, new AbortController().signal, report);
    const completed = expect(result).resolves.toMatchObject({ size: 2 });
    await vi.advanceTimersByTimeAsync(59_800);
    await completed;
    expect(report.mock.calls.map(([value]) => value.stage)).toEqual([
      'metadata',
      'download-response',
      'download',
      'download',
      'metadata',
    ]);
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
