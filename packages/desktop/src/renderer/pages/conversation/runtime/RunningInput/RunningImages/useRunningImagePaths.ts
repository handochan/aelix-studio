/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useState } from 'react';
import type { ComposerDraft } from '@/renderer/components/chat/SendBox';
import type { RunningInputReferences } from '@/renderer/services/runtime/RunningInput';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import type { RunningImageController } from '../useRunningInput';

type Click = { message: string; draft: ComposerDraft; draftVersion: object | undefined };

export type RunningImagePaths = {
  /** Record the composed message of a send click before it reaches the running input client. */
  remember: (message: string, draft: ComposerDraft) => void;
  /** The visible block allows path-only delivery and the composer still holds that click's draft. */
  available: boolean;
  /**
   * Send the unchanged draft with its original refs as paths on a new explicit click.
   * Resolves to whether it was queued and whether the click's quote/snippets are still current.
   */
  send: (references: RunningInputReferences) => Promise<{ sent: boolean; decorationsCurrent: boolean }>;
};

function offers(
  images: RunningImageController | undefined,
  click: Click | undefined,
  draftVersion: object | undefined
): click is Click {
  const submission = images?.submission;
  return (
    submission?.status === 'blocked' &&
    submission.allowPathOnly &&
    !!click &&
    click.draftVersion === draftVersion &&
    !click.draft.decorationSignal?.aborted
  );
}

/**
 * Path-only delivery for a blocked image submission. The blocked card can be acted on
 * only while the composer still holds the same draft: editing the text, attachments,
 * session references, quote or snippets hides the action instead of sending stale text.
 */
export function useRunningImagePaths(
  images: RunningImageController | undefined,
  draftVersion: object | undefined
): RunningImagePaths {
  const [click, setClick] = useState<Click>();
  const latest = useLatestRef({ images, draftVersion, click });

  const remember = useCallback(
    (message: string, draft: ComposerDraft) => setClick({ message, draft, draftVersion: latest.current.draftVersion }),
    [latest]
  );

  // A changed quote or snippet aborts the click's signal without a render here.
  useEffect(() => {
    const signal = click?.draft.decorationSignal;
    if (!signal) return;
    const forget = () => setClick((value) => (value === click ? undefined : value));
    if (signal.aborted) forget();
    signal.addEventListener('abort', forget);
    return () => signal.removeEventListener('abort', forget);
  }, [click]);

  const available = offers(images, click, draftVersion);

  const send = useCallback(
    async (references: RunningInputReferences) => {
      const { images: controller, click: value, draftVersion: version } = latest.current;
      if (!controller || !value || !offers(controller, value, version))
        return { sent: false, decorationsCurrent: false };
      const route = await controller.submitPaths(value.message, references, value.draft);
      return { sent: route === 'sent', decorationsCurrent: !value.draft.decorationSignal?.aborted };
    },
    [latest]
  );

  return { remember, available, send };
}
