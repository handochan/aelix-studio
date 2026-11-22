/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import {
  RunningInputNotices,
  useRunningImagePaths,
  type RunningImageController,
} from '@/renderer/pages/conversation/runtime/RunningInput';
import { buildRunningInputNotices } from '@/renderer/pages/conversation/runtime/RunningInput/notices';
import {
  IMAGE_ONLY_CAPTION,
  type RunningImageBatch,
  type RunningImageDetails,
  type RunningImageSubmission,
  type RunningInputReceipt,
} from '@/renderer/services/runtime/RunningInput';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en-US' },
  }),
}));

const TARGET = { bindingId: 'binding-1', turnId: 'turn-1', mode: 'steer', requestId: 'request-1' } as const;
const PASSTHROUGH: RunningImageDetails = {
  original: { width: 800, height: 600, bytes: 50_000 },
  sent: { width: 800, height: 600, bytes: 50_000, sha256: 'a'.repeat(64) },
  downscaled: false,
  orientationOnly: false,
};
const DOWNSCALED: RunningImageDetails = {
  original: { width: 6000, height: 4000, bytes: 9_000_000 },
  sent: { width: 2048, height: 1365, bytes: 1_200_000, sha256: 'b'.repeat(64) },
  downscaled: true,
  orientationOnly: false,
};
const ROTATED: RunningImageDetails = {
  original: { width: 3000, height: 4000, bytes: 2_000_000 },
  sent: { width: 3000, height: 4000, bytes: 1_900_000, sha256: 'c'.repeat(64) },
  downscaled: false,
  orientationOnly: true,
};
const BATCH: RunningImageBatch = { images: [PASSTHROUGH, DOWNSCALED, ROTATED], estimatedLineBytes: 1_700_000 };

type Entry = RunningImageController['receipts'][number];
type Receipt = Entry['receipt'];

const receipt = (overrides: Partial<Receipt> & Pick<Receipt, 'status'>): Receipt =>
  ({ ...TARGET, hostTurnId: 'host-1', pixels: BATCH, ...overrides }) as Receipt;

function controller(overrides: Partial<RunningImageController> = {}): RunningImageController {
  return {
    modes: ['steer', 'follow-up'],
    receipts: [],
    preview: () => undefined,
    dismissSubmission: vi.fn(),
    cancelPreparation: vi.fn(),
    submitPaths: vi.fn(async () => 'sent' as const),
    ...overrides,
  };
}

const handlers = () => ({ onDismiss: vi.fn(), onCheck: vi.fn(), onSendPaths: vi.fn() });

function renderNotices(images: RunningImageController, props: Partial<ReturnType<typeof handlers>> = handlers()) {
  const callbacks = { ...handlers(), ...props };
  const view = render(<RunningInputNotices notices={[]} images={images} {...callbacks} />);
  return { ...view, ...callbacks };
}

const submission = (value: Partial<RunningImageSubmission> & Pick<RunningImageSubmission, 'status'>) =>
  ({ ...TARGET, ...value }) as RunningImageSubmission;

describe('running image submission', () => {
  it('shows reference and image preparation with progress and a cancel action', () => {
    const images = controller({ submission: submission({ status: 'preparing', stage: 'references', fileCount: 2 }) });
    const view = renderNotices(images);
    expect(screen.getByTestId('running-image-submission')).toHaveTextContent(
      'acp.runningInput.images.preparingReferences {"total":2}'
    );
    fireEvent.click(screen.getByText('acp.runningInput.images.cancel'));
    expect(images.cancelPreparation).toHaveBeenCalledTimes(1);

    const preparing = controller({
      submission: submission({
        status: 'preparing',
        stage: 'images',
        imageCount: 3,
        progress: { index: 1, image: { stage: 'upload', loaded: 40, total: 100 } },
        batch: BATCH,
      }),
    });
    view.rerender(<RunningInputNotices notices={[]} images={preparing} {...handlers()} />);
    const row = screen.getByTestId('running-image-submission');
    expect(row).toHaveAttribute('data-status', 'preparing');
    expect(row).toHaveTextContent('acp.runningInput.images.preparing {"total":3,"mode":"acp.runningInput.mode.steer"}');
    expect(row).toHaveTextContent('acp.runningInput.images.progressPercent');
    expect(row).toHaveTextContent(
      '"index":2,"total":3,"stage":"acp.runningInput.images.stage.uploading","percent":"40%"'
    );
    // No preview exists before a write: every image is an icon with the transmitted W×H.
    expect(within(row).getAllByTestId('running-image-icon')).toHaveLength(3);
    expect(within(row).queryByTestId('running-image-thumbnail')).toBeNull();
    expect(row).toHaveTextContent('acp.runningInput.images.line');
  });

  it.each([
    ['model-text-only', 'acp.runningInput.images.reason.textOnlyModel'],
    ['unsupported-format', 'acp.runningInput.images.reason.unsupportedFormat'],
    ['secure-context-required', 'acp.runningInput.images.reason.secureContext'],
    ['model-changed', 'acp.runningInput.images.reason.modelChanged'],
    ['grant-mismatch', 'acp.runningInput.images.reason.grantFailed'],
  ] as const)('explains a %s block and offers path-only delivery', (reason, key) => {
    const images = controller({ submission: submission({ status: 'blocked', reason, allowPathOnly: true }) });
    const view = renderNotices(images);
    const row = screen.getByTestId('running-image-submission');
    expect(row).toHaveAttribute('data-reason', reason);
    expect(row).toHaveTextContent('acp.runningInput.images.blocked');
    expect(row).toHaveTextContent(key);
    expect(row).not.toHaveTextContent('acp.runningInput.images.limits');

    fireEvent.click(screen.getByText('acp.runningInput.images.sendPaths'));
    expect(view.onSendPaths).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByLabelText('acp.runningInput.dismiss'));
    expect(images.dismissSubmission).toHaveBeenCalledTimes(1);
  });

  it('hides path-only delivery when the composer cannot offer it', () => {
    const images = controller({
      submission: submission({ status: 'blocked', reason: 'model-text-only', allowPathOnly: true }),
    });
    renderNotices(images, { onSendPaths: undefined });
    expect(screen.queryByText('acp.runningInput.images.sendPaths')).toBeNull();
  });

  it('states the exact limits and measured originals for an over-limit submission', () => {
    const images = controller({
      submission: submission({
        status: 'blocked',
        reason: 'limits',
        allowPathOnly: true,
        measurements: {
          originals: [{ width: 9000, height: 7000, bytes: 3_750_001 }, undefined, { bytes: 1024 }],
          originalLineBytes: 8 * 1024 * 1024 + 1,
        },
      }),
    });
    renderNotices(images);
    const row = screen.getByTestId('running-image-submission');
    expect(row).toHaveTextContent(
      'acp.runningInput.images.limits {"fileBytes":"3,750,000 B","edge":"8,000","images":4,"totalBytes":"6 MiB","lineBytes":"8 MiB"}'
    );
    expect(within(row).getAllByTestId('running-image-tile')).toHaveLength(2);
    expect(row).toHaveTextContent(/images\.dimensions \W+width\W+9000\W+height\W+7000/);
    expect(within(row).getAllByTestId('running-image-tile')[0]).toHaveAttribute('title', '3,750,001 B');
    expect(row).toHaveTextContent('acp.runningInput.images.line {"size":"8 MB","limit":"8 MiB"}');
  });

  it('uses the remaining model limits when the image state reports them', () => {
    const images = controller({
      state: {
        available: true,
        model: 'vision',
        turnId: 'turn-1',
        limits: {
          maxImages: 2,
          maxFileBytes: 1_000_000,
          maxTotalBytes: 2 * 1024 * 1024,
          maxEdge: 4096,
          maxLineBytes: 3_000_000,
        },
      },
      submission: submission({ status: 'blocked', reason: 'image-count', allowPathOnly: false }),
    });
    renderNotices(images);
    const row = screen.getByTestId('running-image-submission');
    expect(row).toHaveTextContent('acp.runningInput.images.reason.imageCount {\\"max\\":2');
    expect(screen.queryByText('acp.runningInput.images.sendPaths')).toBeNull();
    expect(row).toHaveTextContent('"fileBytes":"1,000,000 B","edge":"4,096","images":2,"totalBytes":"2 MiB"');
  });
});

describe('running image receipts', () => {
  it('shows the queue acceptance with receipt-bound thumbnails and orientation-aware sizes', () => {
    const preview = vi.fn((requestId: string, sha256: string) =>
      requestId === 'request-1' && sha256 === DOWNSCALED.sent.sha256 ? 'blob:thumbnail' : undefined
    );
    const images = controller({
      preview,
      receipts: [{ receipt: receipt({ status: 'queued', captionAdded: false }), phase: 'active', canLookup: true }],
    });
    const view = renderNotices(images);
    const row = screen.getByTestId('running-input-notice');
    expect(row).toHaveAttribute('data-kind', 'queued');
    expect(row).toHaveTextContent('acp.runningInput.images.queued {"mode":"acp.runningInput.mode.steer"}');

    const tiles = within(row).getAllByTestId('running-image-tile');
    expect(tiles).toHaveLength(3);
    // Passthrough: no downscale label, icon + W×H because no preview is bound.
    expect(within(tiles[0]).getByTestId('running-image-icon')).toHaveAccessibleName(
      'acp.runningInput.images.thumbnail {"index":1} acp.runningInput.images.dimensions {"width":800,"height":600}'
    );
    expect(tiles[0]).not.toHaveTextContent('acp.runningInput.images.downscaled');
    expect(tiles[0]).not.toHaveTextContent('acp.runningInput.images.orientation');
    // Derived: thumbnail from the transmitted digest and both sizes.
    expect(within(tiles[1]).getByTestId('running-image-thumbnail')).toHaveAttribute('src', 'blob:thumbnail');
    expect(tiles[1]).toHaveTextContent('acp.runningInput.images.downscaled');
    expect(tiles[1]).toHaveTextContent(/width\W+6000\W+height\W+4000.+width\W+2048\W+height\W+1365/);
    expect(tiles[1]).toHaveAttribute('title', expect.stringContaining('9,000,000 B'));
    expect(tiles[1]).toHaveAttribute('title', expect.stringContaining('1,200,000 B'));
    // Orientation-only normalization is stated distinctly from a downscale.
    expect(tiles[2]).toHaveTextContent('acp.runningInput.images.orientation');
    expect(tiles[2]).not.toHaveTextContent('acp.runningInput.images.downscaled');
    expect(preview).toHaveBeenCalledWith('request-1', DOWNSCALED.sent.sha256);
    expect(within(row).queryByTestId('running-image-caption')).toBeNull();
    expect(row).not.toHaveTextContent(/consumed/i);

    // A released preview is not retained by the UI: the next render shows the icon.
    view.rerender(
      <RunningInputNotices notices={[]} images={{ ...images, preview: () => undefined }} {...handlers()} />
    );
    expect(screen.queryByTestId('running-image-thumbnail')).toBeNull();
    expect(screen.getAllByTestId('running-image-icon')).toHaveLength(3);
  });

  it('falls back to the icon and transmitted size when a thumbnail fails to render', () => {
    const images = controller({
      preview: () => 'blob:broken',
      receipts: [
        {
          receipt: receipt({ status: 'queued', pixels: { images: [DOWNSCALED], estimatedLineBytes: 1 } }),
          phase: 'active',
          canLookup: true,
        },
      ],
    });
    renderNotices(images);
    fireEvent.error(screen.getByTestId('running-image-thumbnail'));
    expect(screen.queryByTestId('running-image-thumbnail')).toBeNull();
    expect(screen.getByTestId('running-image-icon')).toHaveAccessibleName(
      'acp.runningInput.images.thumbnail {"index":1} acp.runningInput.images.dimensions {"width":2048,"height":1365}'
    );
    expect(screen.getByTestId('running-image-tile')).toHaveTextContent(/width\W+2048\W+height\W+1365/);
  });

  it('shows the fixed caption in the notice only when ACP added it', () => {
    const images = controller({
      receipts: [{ receipt: receipt({ status: 'queued', captionAdded: true }), phase: 'active', canLookup: true }],
    });
    renderNotices(images);
    const caption = screen.getByTestId('running-image-caption');
    expect(caption).toHaveTextContent('acp.runningInput.images.caption');
    expect(caption).toHaveTextContent(IMAGE_ONLY_CAPTION);
  });

  it.each([
    ['ended', 'acp.runningInput.images.queuedEnded'],
    ['stopped', 'acp.runningInput.images.queuedStopped'],
    ['stop-unconfirmed', 'acp.runningInput.images.queuedStopped'],
  ] as const)('keeps a late acceptance on its original %s turn', (phase, key) => {
    renderNotices(controller({ receipts: [{ receipt: receipt({ status: 'queued' }), phase, canLookup: false }] }));
    expect(screen.getByTestId('running-input-notice')).toHaveTextContent(key);
    expect(screen.getByTestId('running-input-notice')).not.toHaveTextContent('acp.runningInput.images.queued {');
  });

  it('offers a result check for an unknown write on its original request', () => {
    const view = renderNotices(
      controller({ receipts: [{ receipt: receipt({ status: 'unknown' }), phase: 'active', canLookup: true }] })
    );
    const row = screen.getByTestId('running-input-notice');
    expect(row).toHaveTextContent('acp.runningInput.images.unknown');
    fireEvent.click(within(row).getByText('acp.runningInput.images.checkResult'));
    expect(view.onCheck).toHaveBeenCalledWith('request-1');
    fireEvent.click(within(row).getByLabelText('acp.runningInput.dismiss'));
    expect(view.onDismiss).toHaveBeenCalledWith(['request-1']);
  });

  it('shows pending without a dismiss action and explains ACP rejections', () => {
    renderNotices(
      controller({
        receipts: [
          { receipt: receipt({ status: 'pending' }), phase: 'active', canLookup: true },
          {
            receipt: receipt({ status: 'rejected', reason: 'provider-context-limit', requestId: 'request-2' }),
            phase: 'active',
            canLookup: true,
          },
          {
            receipt: receipt({
              status: 'rejected',
              failure: { status: 429, code: 'EXT_RATE_LIMITED' },
              requestId: 'request-3',
            }),
            phase: 'active',
            canLookup: true,
          },
        ],
      })
    );
    const [pending, rejected, relay] = screen.getAllByTestId('running-input-notice');
    expect(pending).toHaveTextContent('acp.runningInput.images.pending');
    expect(within(pending).queryByLabelText('acp.runningInput.dismiss')).toBeNull();
    expect(rejected).toHaveTextContent('acp.runningInput.images.reason.contextFull');
    expect(relay).toHaveTextContent('acp.runningInput.reason.rateLimited');
    expect(screen.getByText('acp.runningInput.dismissAll')).toBeInTheDocument();
  });

  it('renders each pixel receipt once, outside the grouped text notices', () => {
    const pixels = receipt({ status: 'queued' });
    const text = { ...TARGET, requestId: 'text-1', status: 'queued' } as RunningInputReceipt;
    expect(buildRunningInputNotices([pixels, text], undefined, new Map())).toMatchObject([
      { kind: 'queued', requestIds: ['text-1'] },
    ]);
  });
});

const windowState = (requestSequence: number) => ({
  available: false as const,
  reason: 'model-unverified' as const,
  turnId: 'turn-1',
  window: {
    requestTurnId: 'turn-1',
    workerGeneration: 'worker-1',
    requestSequence,
    keptCount: 20,
    keptRawBytes: 8 * 1024 * 1024,
    omittedCount: 3,
    reasons: { image_count: 2, raw_bytes: 1 },
  },
});

describe('provider image window', () => {
  it('states omitted images and reasons until that sample is dismissed', () => {
    const view = renderNotices(controller({ state: windowState(1) }));
    const row = screen.getByTestId('running-image-window');
    expect(row).toHaveTextContent('acp.runningInput.images.window {"omitted":3,"kept":20,"bytes":"8 MB"}');
    expect(row).toHaveTextContent('acp.runningInput.images.windowReason.count');
    expect(row).toHaveTextContent('acp.runningInput.images.windowReason.bytes');
    fireEvent.click(within(row).getByLabelText('acp.runningInput.dismiss'));
    expect(screen.queryByTestId('running-image-window')).toBeNull();

    view.rerender(<RunningInputNotices notices={[]} images={controller({ state: windowState(2) })} {...handlers()} />);
    expect(screen.getByTestId('running-image-window')).toBeInTheDocument();
  });
});

describe('path-only delivery', () => {
  const DRAFT = { slashCommand: false, hasQuote: false };
  const REFERENCES = { files: [{ kind: 'upload' as const, path: '/client/a.png' }], sessions: [] };
  const blocked = (allowPathOnly = true) =>
    controller({ submission: submission({ status: 'blocked', reason: 'model-text-only', allowPathOnly }) });

  it('sends the unchanged draft with its original refs on an explicit click', async () => {
    const images = blocked();
    const version = {};
    const { result } = renderHook(({ draftVersion }) => useRunningImagePaths(images, draftVersion), {
      initialProps: { draftVersion: version },
    });
    expect(result.current.available).toBe(false);
    act(() => result.current.remember('> quote\n\nhello', DRAFT));
    expect(result.current.available).toBe(true);
    let outcome: { sent: boolean; decorationsCurrent: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.send(REFERENCES);
    });
    expect(images.submitPaths).toHaveBeenCalledWith('> quote\n\nhello', REFERENCES, DRAFT);
    expect(outcome).toEqual({ sent: true, decorationsCurrent: true });
  });

  it.each(['draft', 'decorations', 'not-allowed'] as const)(
    'does not offer stale delivery after a %s change',
    async (change) => {
      const decorations = new AbortController();
      const images = blocked(change !== 'not-allowed');
      const { result, rerender } = renderHook(({ draftVersion }) => useRunningImagePaths(images, draftVersion), {
        initialProps: { draftVersion: {} as object },
      });
      act(() => result.current.remember('hello', { ...DRAFT, decorationSignal: decorations.signal }));
      if (change === 'draft') rerender({ draftVersion: {} });
      if (change === 'decorations') act(() => decorations.abort());
      expect(result.current.available).toBe(false);
      await act(async () => {
        expect(await result.current.send(REFERENCES)).toEqual({ sent: false, decorationsCurrent: false });
      });
      expect(images.submitPaths).not.toHaveBeenCalled();
    }
  );
});
