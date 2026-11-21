/** Invoke the emitted S-1a entry from the application document. Runs in the browser. */
export async function exerciseImageWorker({
  entry,
  name,
  base64,
  conversationId,
  byteLimit,
  edgeLimit,
  expected,
  useRef,
  cancelDuringHash,
  forceJsHash,
}) {
  const api = await import(new URL(entry, document.baseURI).href);
  const blob = base64
    ? new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))])
    : globalThis.__imageWorkerProbeSource;
  delete globalThis.__imageWorkerProbeSource;
  const controller = new AbortController();
  const progress = [];
  const options = {
    signal: controller.signal,
    conversationId,
    model: { supported: true, maxFileBytes: byteLimit, maxEdge: edgeLimit },
    forceJsHash,
    emptyNativeLine: (requestId, mimes) =>
      JSON.stringify({
        type: 'steer',
        id: requestId,
        message: '한"\n',
        images: mimes.map((mime_type) => ({ type: 'image', mime_type, data: '' })),
      }) + '\n',
    onProgress: (_index, update) => {
      progress.push(update);
      if (cancelDuringHash && update.stage === 'hash-original' && update.loaded > 0 && update.loaded < update.total) {
        controller.abort();
      }
    },
  };
  const started = performance.now();
  const job = api.createImagePreparation({
    ...options,
    sources: [useRef ? { ref: useRef } : { blob }],
  });
  try {
    const pending = job.prepare();
    const result = await pending;
    if (expected) throw new Error(`Expected failure: ${expected}`);
    if (job.prepare() !== pending || !/^[\da-f-]{14}7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(result.requestId)) {
      throw new Error('Preparation identity changed');
    }
    const [image] = result.images;
    const streamBase = window.__backendPort ? `http://127.0.0.1:${window.__backendPort}` : location.origin;
    const params = new URLSearchParams({ kind: image.ref.kind, path: image.ref.path });
    const response = await fetch(`${streamBase}/api/fs/stream?${params}`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Readback failed: ${response.status}`);
    const output = await response.blob();
    const outputBytes = new Uint8Array(await output.arrayBuffer());
    let writes = 0;
    // The Node driver independently hashes these same ACP fixture argument bytes.
    const grant = { byteLength: output.size, sha256: image.sent.digest.sha256 };
    try {
      api.verifyImageGrants(result, [{ ...grant, sha256: '0'.repeat(64) }]);
      writes++;
    } catch (error) {
      if (error.code !== 'grant-mismatch') throw error;
    }
    if (writes !== 0) throw new Error('Accepted a mismatched grant');
    api.verifyImageGrants(result, [grant]);
    let pixels;
    if (name.startsWith('exif-') || name.startsWith('baseline-') || name.startsWith('cmyk') || name === 'alpha.png') {
      const bitmap = await createImageBitmap(output);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      ctx.drawImage(bitmap, 0, 0);
      pixels = [0.25, 0.75].flatMap((y) =>
        [0.25, 0.75].map((x) =>
          Array.from(ctx.getImageData(Math.floor(x * bitmap.width), Math.floor(y * bitmap.height), 1, 1).data)
        )
      );
      bitmap.close();
    }
    const { ref, original, sent, preview, changed, plannedBytes, codecMs, secureContext } = image;
    // Use small pairs to avoid a variadic call with a multi-MiB argument list.
    const chunkSize = 0x4000;
    const chunks = [];
    for (let offset = 0; offset < outputBytes.length; offset += chunkSize) {
      chunks.push(String.fromCharCode(...outputBytes.subarray(offset, offset + chunkSize)));
    }
    return {
      ref,
      original,
      sent,
      preview: preview.kind,
      previewDigest: preview.value?.forSha256,
      changed,
      plannedBytes,
      codecMs,
      pixels,
      secureContext,
      windowSecure: isSecureContext,
      uploadProgress: progress.filter((value) => value.stage.startsWith('upload')),
      hashProgress: progress.filter((value) => value.stage.startsWith('hash')),
      estimatedLineBytes: result.estimatedLineBytes,
      totalMs: performance.now() - started,
      output: btoa(chunks.join('')),
    };
  } catch (error) {
    if (error.code !== expected) {
      const { stage = 'prepare', loaded = 0 } = progress.at(-1) ?? {};
      throw new Error(`${name}: ${error.code || 'fixture-failed'} (${stage}, ${loaded} bytes)`);
    }
    return { code: error.code, windowSecure: isSecureContext, progress, originalSize: blob.size };
  } finally {
    job.dispose();
  }
}

/** Measure a mixed four-image submission in the same renderer and worker budget. */
export async function exerciseImageBatch({ entry, conversationId, references, large }) {
  const api = await import(new URL(entry, document.baseURI).href);
  const blob = new Blob([Uint8Array.from(atob(large), (char) => char.charCodeAt(0))]);
  const controller = new AbortController();
  const job = api.createImagePreparation({
    signal: controller.signal,
    conversationId,
    sources: [{ blob }, ...references.map((ref) => ({ ref }))],
    model: { supported: true },
    forceJsHash: true,
    emptyNativeLine: (requestId, mimes) =>
      JSON.stringify({
        type: 'steer',
        id: requestId,
        message: '한"\n',
        images: mimes.map((mime_type) => ({ type: 'image', mime_type, data: '' })),
      }) + '\n',
  });
  const started = performance.now();
  try {
    const prepared = await job.prepare();
    return {
      codecMs: prepared.codecMs,
      wallMs: performance.now() - started,
      estimatedLineBytes: prepared.estimatedLineBytes,
      images: prepared.images.map((image, index) => ({
        kind: image.ref.kind,
        preservedRef: index === 0 || JSON.stringify(image.ref) === JSON.stringify(references[index - 1]),
        codecMs: image.codecMs,
        bytes: image.sent.bytes,
        changed: image.changed,
      })),
    };
  } finally {
    job.dispose();
  }
}

/** Submit a small file. The driver can hold or fail the actual upload response. */
export async function startUploadFixture({ entry, conversationId, base64 }) {
  const api = await import(new URL(entry, document.baseURI).href);
  const create = (blob) =>
    api.createImagePreparation({
      signal: new AbortController().signal,
      conversationId,
      sources: [{ blob }],
      model: { supported: true },
      emptyNativeLine: (id, mimes) =>
        JSON.stringify({
          id,
          images: mimes.map((mime_type) => ({ type: 'image', mime_type, data: '' })),
        }) + '\n',
    });
  const job = create(new Blob([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))]));
  const first = job.prepare();
  const outcome = first.then(
    () => 'fulfilled',
    (error) => error.code
  );
  globalThis.__imageUploadFixture = {
    job,
    first,
    outcome,
    async cancelQueuedBlobs() {
      const handles = Array.from({ length: 12 }, () => {
        const blob = new Blob([new Uint8Array(16 * 1024 * 1024)]);
        return { weak: new WeakRef(blob), job: create(blob) };
      });
      const cancelled = await Promise.all(
        handles.map(({ job: queued }) => {
          const rejection = queued.prepare().then(
            () => false,
            (error) => error.code === 'cancelled'
          );
          queued.dispose();
          return rejection;
        })
      );
      globalThis.__imageCancelledBlobs = handles;
      return cancelled.filter(Boolean).length;
    },
  };
}
