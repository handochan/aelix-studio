/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  failureLabel,
  mismatchLabel,
  scopeReasonLabel,
} from '@/renderer/pages/settings/ToolsSettings/AelixNative/labels';

const failure = (status: 'stale', reason: string) =>
  ({ status, reason, action: 'refresh', retryWrite: false }) as const;

describe('Aelix native settings labels', () => {
  it('describes a stale list without mentioning a conversation, unless the binding changed', () => {
    expect(failureLabel(failure('stale', 'CURSOR_STALE')).key).toBe('settings.aelixNative.failure.listChanged');
    expect(failureLabel(failure('stale', 'cursor-stale')).key).toBe('settings.aelixNative.failure.listChanged');
    expect(failureLabel(failure('stale', 'EXT_STALE_BINDING')).key).toBe('settings.aelixNative.failure.stale');
  });

  it('maps mismatch reasons and a missing scope reason to translated text', () => {
    expect(mismatchLabel('saved-value-differs').key).toBe('settings.aelixNative.mismatchReason.savedValueDiffers');
    expect(mismatchLabel('custom')).toEqual({
      key: 'settings.aelixNative.mismatchReason.other',
      values: { reason: 'custom' },
    });
    expect(scopeReasonLabel(null)).toEqual({ key: 'settings.aelixNative.scopeReason.unknown' });
  });
});
