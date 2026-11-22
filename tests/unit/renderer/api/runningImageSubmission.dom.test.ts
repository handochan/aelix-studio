import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunningInputClient } from '@renderer/services/runtime/RunningInput';
import {
  createImagePreparation,
  ImagePreparationError,
  type PreparedImage,
} from '@renderer/services/runtime/RunningInput/Images';
import { nativeLineBytes } from '@renderer/services/runtime/RunningInput/Images/budget';
import {
  emptyNativeImageLine,
  IMAGE_ONLY_CAPTION,
  RUNNING_IMAGE_LIMITS,
} from '@renderer/services/runtime/RunningInput/imageProtocol';

vi.mock('@renderer/services/runtime/RunningInput/Images', { spy: true });

const target = { bindingId: 'binding', turnId: 'turn' };
const original = { kind: 'local', path: '/file.png' } as const;
const derivative = { kind: 'upload', path: '/derived.png' } as const;
const requestId = '019bf000-0000-7000-8000-000000000104';
const digest = { sha256: 'a'.repeat(64), algorithm: 'js', elapsedMs: 0 } as const;
const image: PreparedImage = {
  originalRef: original,
  ref: derivative,
  original: { width: 3000, height: 2000, bytes: 4_000_000, digest },
  sent: { width: 2048, height: 1365, bytes: 60, digest, mime: 'image/png' },
  preview: { kind: 'thumbnail', value: { blob: new Blob(), forSha256: digest.sha256 } },
  changed: true,
  orientationOnly: false,
  secureContext: false,
  codecMs: 1,
  plannedBytes: 1,
};
const methods = ['input/state', 'input/image-state', 'input/steer', 'input/steer-images', 'requests/lookup'];
const eligible = {
  status: 'available',
  available: true,
  turnId: target.turnId,
  model: 'fixture/vision',
  remaining: { count: 4, rawBytes: 6 << 20, imageBytes: 3_750_000, sidePixels: 8000, nativeLineBytes: 8 << 20 },
};
const grant = { id: 'opaque', byteLength: 60, sha256: digest.sha256 };
const accepted = {
  accepted: true,
  delivery: 'native-queue',
  inputKind: 'pixels',
  turnId: target.turnId,
  captionAdded: true,
};
const success = (data: unknown) => Response.json({ success: true, data });
const result = (value: unknown) => success({ result: value });

describe('running image submissions', () => {
  const fetcher = vi.fn<(path: string, init: RequestInit) => Promise<Response>>();
  const prepare = vi.fn();
  const createURL = vi.fn(() => 'blob:preview');
  const revokeURL = vi.fn();
  const mockPreparation = vi.mocked(createImagePreparation);
  let client: ReturnType<typeof createRunningInputClient>;

  function offer(hostBytes = true, requested = methods, bindingId = target.bindingId) {
    fetcher
      .mockResolvedValueOnce(
        success({
          version: 1,
          bindingId,
          hostBytes,
          requests: requested.map((method) => '_aelix/session/' + method),
        })
      )
      .mockResolvedValueOnce(result({ active: true, turnId: target.turnId }));
  }

  function submit(message = '', count = 1) {
    return client.submitImages({
      ...target,
      requestId,
      message,
      mode: 'steer',
      sources: Array.from({ length: count }, () => ({ ref: original })),
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
  }

  beforeEach(() => {
    fetcher.mockReset();
    prepare
      .mockReset()
      .mockResolvedValue({ prepareId: requestId, requestId, images: [image], estimatedLineBytes: 300 });
    createURL.mockClear();
    revokeURL.mockClear();
    mockPreparation.mockReset().mockReturnValue({ prepare, dispose: vi.fn() });
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal(
      'URL',
      Object.assign(class extends URL {}, {
        createObjectURL: createURL,
        revokeObjectURL: revokeURL,
      })
    );
    client = createRunningInputClient('image-test');
  });

  afterEach(() => {
    client.dispose();
    vi.unstubAllGlobals();
  });

  it.each([
    [false, methods],
    [true, methods.filter((method) => method !== 'input/steer-images')],
  ])('keeps pixels off without both Host and ACP negotiation', async (hostBytes, requested) => {
    offer(hostBytes, requested);
    await client.refresh();
    await submit();
    expect(client.getSnapshot().imageSubmission).toMatchObject({ status: 'blocked', reason: 'contract-unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['request', 'response body'])(
    'reuses the original request key after a lost grant %s and recovers an unknown ACK by lookup',
    async (loss) => {
      offer();
      await client.refresh();
      fetcher
        .mockResolvedValueOnce(result(eligible))
        .mockImplementationOnce(async () => {
          if (loss === 'request') throw new Error('private fixture');
          return new Response('{"success":', { status: 200 });
        })
        .mockResolvedValueOnce(success({ expiresInMs: 50_000, grants: [grant] }))
        .mockResolvedValueOnce(result(eligible))
        .mockRejectedValueOnce(new Error('private fixture'))
        .mockResolvedValueOnce(result({ status: 'completed', result: accepted }));
      const outcome = await submit();
      expect(outcome).toMatchObject({ status: 'sent', preserveDraft: true, receipt: { status: 'unknown', requestId } });
      expect(client.getImagePreview(requestId, digest.sha256)).toBeUndefined();
      expect(fetcher.mock.calls.slice(3, 5).map(([, init]) => JSON.parse(String(init.body)))).toEqual([
        { prepareId: requestId, bindingId: target.bindingId, refs: [derivative] },
        { prepareId: requestId, bindingId: target.bindingId, refs: [derivative] },
      ]);
      expect(await client.lookup(requestId)).toMatchObject({
        status: 'completed',
        receipt: { ...target, requestId, status: 'queued', captionAdded: true },
      });
      const [, write] = fetcher.mock.calls[6];
      const [, lookup] = fetcher.mock.calls[7];
      expect(JSON.parse(String(write.body))).toMatchObject({
        method: '_aelix/session/input/steer-images',
        payload: { turnId: target.turnId, requestId, message: '', grants: ['opaque'] },
      });
      expect(JSON.parse(String(lookup.body))).toMatchObject({
        method: '_aelix/session/requests/lookup',
        bindingId: target.bindingId,
        payload: { requestId },
      });
      expect(client.getImagePreview(requestId, digest.sha256)).toBe('blob:preview');
      client.dismiss(requestId);
      expect(revokeURL).toHaveBeenCalledWith('blob:preview');
    }
  );

  it('retains the original unknown receipt when its write discovers a replacement binding', async () => {
    offer();
    await client.refresh();
    fetcher
      .mockResolvedValueOnce(result(eligible))
      .mockResolvedValueOnce(success({ expiresInMs: 50_000, grants: [grant] }))
      .mockResolvedValueOnce(result(eligible))
      .mockResolvedValueOnce(Response.json({ success: false, code: 'EXT_OUTCOME_UNKNOWN' }, { status: 409 }));
    offer(true, methods, 'replacement');

    const sent = await submit();
    expect(sent).toMatchObject({
      status: 'sent',
      preserveDraft: true,
      receipt: { ...target, requestId, status: 'unknown' },
    });
    expect(client.getSnapshot()).toMatchObject({
      channel: { status: 'ready', bindingId: 'replacement' },
      receipts: [{ ...target, requestId, status: 'unknown' }],
    });
    const requests = fetcher.mock.calls.length;
    expect(await client.lookup(requestId)).toEqual({ status: 'binding-changed', refreshHistory: true });
    expect(fetcher).toHaveBeenCalledTimes(requests);
    client.dismiss(requestId);
    expect(client.getSnapshot().receipts).toHaveLength(0);
  });

  it.each(['model', 'turn', 'grant'] as const)(
    'keeps the draft and emits zero writes when the %s changes',
    async (change) => {
      offer();
      await client.refresh();
      fetcher.mockResolvedValueOnce(result(eligible)).mockResolvedValueOnce(
        success({
          expiresInMs: 50_000,
          grants: [change === 'grant' ? { ...grant, byteLength: 61 } : grant],
        })
      );
      if (change !== 'grant') {
        fetcher.mockResolvedValueOnce(
          result({
            ...eligible,
            ...(change === 'model' ? { model: 'fixture/other' } : { turnId: 'new-turn' }),
          })
        );
      }
      await submit();
      expect(client.getSnapshot().imageSubmission).toMatchObject({
        status: 'blocked',
        reason: { grant: 'grant-mismatch', model: 'model-changed', turn: 'turn-changed' }[change],
      });
      expect(client.getSnapshot().receipts).toEqual([]);
    }
  );

  it('reports a text-only model and a conversion failure as distinct pre-write blocks', async () => {
    offer();
    await client.refresh();
    fetcher.mockResolvedValueOnce(result({ ...eligible, available: false, reason: 'model-text-only' }));
    await submit();
    expect(client.getSnapshot().imageSubmission).toMatchObject({ status: 'blocked', reason: 'model-text-only' });
    expect(prepare).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(result(eligible));
    prepare.mockRejectedValueOnce(new ImagePreparationError('decode-limit'));
    await submit();
    expect(client.getSnapshot().imageSubmission).toMatchObject({
      status: 'blocked',
      reason: 'decode-limit',
      allowPathOnly: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([3, 4, 5])('checks the image count around the four-image boundary (%s)', async (count) => {
    offer();
    await client.refresh();
    fetcher.mockResolvedValueOnce(result(eligible));
    prepare.mockRejectedValueOnce(new ImagePreparationError('codec-unavailable'));
    await submit('', count);
    expect(prepare).toHaveBeenCalledTimes(count > 4 ? 0 : 1);
  });

  it('maps window counts independently of queue acceptance and keeps only known reason keys', async () => {
    offer();
    await client.refresh();
    fetcher.mockResolvedValueOnce(
      result({
        ...eligible,
        requestTurnId: target.turnId,
        workerGeneration: 'generation',
        requestSequence: 3,
        keptCount: 4,
        keptRawBytes: 8,
        omittedCount: 2,
        reasons: { image_count: 2, 'private fixture': 1 },
      })
    );
    await client.refreshImageState();
    expect(client.getSnapshot().imageState?.window).toEqual({
      requestTurnId: target.turnId,
      workerGeneration: 'generation',
      requestSequence: 3,
      keptCount: 4,
      keptRawBytes: 8,
      omittedCount: 2,
      reasons: { image_count: 2 },
    });
    expect(client.getSnapshot().receipts).toEqual([]);
  });
  it('keeps the provider window observed just before natural turn completion', async () => {
    offer();
    await client.refresh();
    fetcher
      .mockResolvedValueOnce(
        success({
          version: 1,
          bindingId: target.bindingId,
          hostBytes: true,
          requests: methods.map((method) => '_aelix/session/' + method),
        })
      )
      .mockResolvedValueOnce(result({ active: false, turnId: null }));
    await client.refresh();
    fetcher.mockResolvedValueOnce(
      result({
        status: 'available',
        available: false,
        reason: 'no-active-turn',
        turnId: null,
        requestTurnId: target.turnId,
        workerGeneration: 'generation',
        requestSequence: 4,
        keptCount: 3,
        keptRawBytes: 8,
        omittedCount: 1,
        reasons: { raw_bytes: 1 },
      })
    );
    await client.refreshImageState();
    expect(client.getSnapshot().imageState).toMatchObject({
      available: false,
      turnId: null,
      window: { requestTurnId: target.turnId, omittedCount: 1 },
    });
  });
});

it('counts escaped UTF-8 JSONL at the native boundary and reserves the caption only for blank text', () => {
  expect(JSON.parse(emptyNativeImageLine('steer', '\u0085 ', ['image/png'])).message).toBe(IMAGE_ONLY_CAPTION);
  expect(JSON.parse(emptyNativeImageLine('follow-up', '\ufeff', ['image/png'])).message).toBe('\ufeff');
  const raw = [3_750_000, 2_540_000];
  const message = '문"\\\n';
  const length = nativeLineBytes(emptyNativeImageLine('steer', message, ['image/png', 'image/jpeg']), raw);
  const pad = RUNNING_IMAGE_LIMITS.maxLineBytes - length;
  for (const offset of [-1, 0, 1]) {
    const serialized = emptyNativeImageLine('steer', message + 'x'.repeat(pad + offset), ['image/png', 'image/jpeg']);
    expect(nativeLineBytes(serialized, raw)).toBe(RUNNING_IMAGE_LIMITS.maxLineBytes + offset);
  }
});
