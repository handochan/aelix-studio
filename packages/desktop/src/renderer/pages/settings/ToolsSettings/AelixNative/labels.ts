/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceFailure } from '@/renderer/services/runtime/NativeResources';

/** An i18n key with interpolation values, resolved by the caller's `t`. */
export type Label = { key: string; values?: Record<string, string> };

const PREFIX = 'settings.aelixNative';

const LOCK_REASONS: Record<string, string> = {
  'launch-locked': 'launchLocked',
  'invalid-mcp-entry': 'invalidMcpEntry',
  'env-config': 'envConfig',
  extension: 'extension',
  untrusted: 'untrusted',
};

const SCOPE_REASONS: Record<string, string> = {
  'management-helper': 'managementHelper',
  'read-only': 'readOnly',
  'missing-file': 'missingFile',
  'env-config': 'envConfig',
  unsupported: 'unsupported',
};

const DIAGNOSTICS: Record<string, string> = {
  'invalid-profile': 'invalidProfile',
  'invalid-settings-entry': 'invalidSettingsEntry',
  'skill-settings-problem': 'skillSettingsProblem',
  'invalid-skill': 'invalidSkill',
  'shadowed-skill': 'shadowedSkill',
  'env-config': 'envConfig',
  'mcp-config-warning': 'mcpConfigWarning',
  'invalid-mcp-key': 'invalidMcpKey',
};

/** Describe why native settings lock a row. Unknown reasons keep their safe code. */
export function lockReasonLabel(reason: string): Label {
  const known = LOCK_REASONS[reason];
  return known ? { key: `${PREFIX}.lock.reason.${known}` } : { key: `${PREFIX}.lock.reason.other`, values: { reason } };
}

const MISMATCHES: Record<string, string> = {
  'saved-value-differs': 'savedValueDiffers',
  'native-mismatch': 'nativeMismatch',
};

const PROMPT_MODES: Record<string, string> = { append: 'append', replace: 'replace' };

const APPROVAL_MODES: Record<string, string> = { inherit: 'inherit' };

/** Describe why a whole scope cannot be written. */
export function scopeReasonLabel(reason: string | null): Label {
  if (reason === null) return { key: `${PREFIX}.scopeReason.unknown` };
  const known = SCOPE_REASONS[reason];
  return known ? { key: `${PREFIX}.scopeReason.${known}` } : { key: `${PREFIX}.scopeReason.other`, values: { reason } };
}

/** Describe why a saved value differs from what is in force. */
export function mismatchLabel(reason: string): Label {
  const known = MISMATCHES[reason];
  return known
    ? { key: `${PREFIX}.mismatchReason.${known}` }
    : { key: `${PREFIX}.mismatchReason.other`, values: { reason } };
}

/** Describe a profile's prompt mode. */
export function promptModeLabel(mode: string): Label {
  const known = PROMPT_MODES[mode];
  return known
    ? { key: `${PREFIX}.profiles.promptModes.${known}` }
    : { key: `${PREFIX}.profiles.promptModes.other`, values: { mode } };
}

/** Describe a profile's delegated approval mode. Unknown modes keep their safe code. */
export function approvalModeLabel(mode: string): Label {
  const known = APPROVAL_MODES[mode];
  return known
    ? { key: `${PREFIX}.profiles.approvalModes.${known}` }
    : { key: `${PREFIX}.profiles.approvalModes.other`, values: { mode } };
}

/** Describe a native diagnostic code. */
export function diagnosticLabel(code: string): Label {
  const known = DIAGNOSTICS[code];
  return known ? { key: `${PREFIX}.diagnostics.${known}` } : { key: `${PREFIX}.diagnostics.other`, values: { code } };
}

/** Describe a read or write failure from the NativeResources client. */
export function failureLabel(failure: ResourceFailure): Label {
  const key = failure.key ?? '';
  switch (failure.status) {
    case 'unsupported':
      return { key: `${PREFIX}.failure.unsupported` };
    case 'unauthenticated':
      return { key: `${PREFIX}.failure.unauthenticated` };
    case 'detached':
      return { key: `${PREFIX}.failure.detached` };
    case 'stale':
      // Only a replaced conversation binding is about the conversation; other stale reads are list changes.
      return failure.reason === 'EXT_STALE_BINDING'
        ? { key: `${PREFIX}.failure.stale` }
        : { key: `${PREFIX}.failure.listChanged` };
    case 'invalid-response':
      return { key: `${PREFIX}.failure.invalid` };
    case 'refused':
      if (failure.reason === 'BUSY' || failure.reason === 'busy') return { key: `${PREFIX}.failure.busy` };
      if (failure.reason === 'SELECTION_LOCKED') return { key: `${PREFIX}.failure.locked`, values: { key } };
      if (failure.reason === 'SELECTION_MISSING') return { key: `${PREFIX}.failure.missing`, values: { key } };
      if (failure.reason === 'SCOPE_READONLY' || failure.reason === 'scope-readonly') {
        return { key: `${PREFIX}.failure.readOnly` };
      }
      return { key: `${PREFIX}.failure.generic`, values: { reason: failure.reason } };
    default:
      return { key: `${PREFIX}.failure.generic`, values: { reason: failure.reason } };
  }
}
