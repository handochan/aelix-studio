/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProfileDifference, ProfileRef } from '@/renderer/services/runtime/NativeResources';
import type { TFunction } from 'i18next';

export const KEY = 'conversation.aelixControls';

export function sameRef(a: ProfileRef | null | undefined, b: ProfileRef | null | undefined): boolean {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.name === b.name && a.scope === b.scope && a.revision === b.revision;
}

/** `sha256:1db1f596…` → `1db1f596`, for display only. Comparisons always use the full revision. */
export function shortRevision(revision: string): string {
  return revision.replace(/^sha256:/, '').slice(0, 8);
}

export function scopeLabel(t: TFunction, scope: ProfileRef['scope']): string {
  return t(`${KEY}.scope.${scope}`);
}

/** `quiet · User · 1db1f596` */
export function refLabel(t: TFunction, ref: ProfileRef | null): string {
  if (!ref) return t(`${KEY}.profile.none`);
  return `${ref.name} · ${scopeLabel(t, ref.scope)} · ${shortRevision(ref.revision)}`;
}

/** A tool list as the profile restricts it: `null` inherits all tools, `[]` allows none. */
export function toolRestriction(t: TFunction, tools: readonly string[] | null): string {
  if (tools === null) return t(`${KEY}.preview.allTools`);
  if (tools.length === 0) return t(`${KEY}.preview.noTools`);
  return tools.join(', ');
}

const DIFFERENCE_FIELDS = new Set([
  'source',
  'revision',
  'description',
  'promptMode',
  'promptPreview',
  'promptTruncated',
  'omittedPrompt',
  'provider',
  'model',
  'tools',
  'skills',
  'approvalMode',
  'builtinTools',
  'excludeTools',
  'inheritSkills',
  'extensions',
  'inheritExtensions',
  'contextFiles',
  'thinking',
  'role',
  'outputCap',
  'timeoutMs',
  'agents',
]);

export function differenceField(t: TFunction, field: string): string {
  return DIFFERENCE_FIELDS.has(field) ? t(`${KEY}.field.${field}`) : field;
}

export function differenceValue(t: TFunction, field: string, value: ProfileDifference['before']): string {
  if (value === null) return t(`${KEY}.value.unset`);
  if (typeof value === 'boolean') return t(value ? `${KEY}.value.yes` : `${KEY}.value.no`);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return field === 'revision' ? shortRevision(value) : value;
  return value.length === 0 ? t(`${KEY}.value.empty`) : value.join(', ');
}

const LOCK_REASONS = new Set(['launch-locked', 'env-config', 'management-helper']);

export function lockReason(t: TFunction, reason: string): string {
  return LOCK_REASONS.has(reason)
    ? t(`${KEY}.lock.${reason === 'launch-locked' ? 'launch' : reason === 'env-config' ? 'env' : 'helper'}`)
    : t(`${KEY}.lock.other`, { reason });
}

const RECOVERY_CAUSES = new Set([
  'declined',
  'cancelled',
  'unanswered',
  'changed-again',
  'profile-unavailable',
  'guard-unavailable',
  'invalid-record',
  'profile-changed',
]);

/** Title key for the recovery card, by the cause the runtime reported. */
export function recoveryTitle(t: TFunction, status: string, reason: string): string {
  if (status === 'unknown') return t(`${KEY}.recovery.cause.unknown`);
  if (!RECOVERY_CAUSES.has(reason)) return t(`${KEY}.recovery.cause.other`);
  const key = reason.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return t(`${KEY}.recovery.cause.${key}`);
}

/** Map a known native code to its label; anything else is shown as "Other (code)". */
function codeLabel(t: TFunction, group: string, labels: Record<string, string>, code: string): string {
  return Object.hasOwn(labels, code) ? t(`${KEY}.code.${group}.${labels[code]}`) : t(`${KEY}.code.other`, { code });
}

export function mismatchLabel(t: TFunction, reason: string): string {
  return codeLabel(
    t,
    'mismatch',
    { 'saved-value-differs': 'savedValueDiffers', 'native-mismatch': 'nativeMismatch' },
    reason
  );
}

export function diagnosticLabel(t: TFunction, code: string): string {
  return codeLabel(t, 'diagnostic', { 'invalid-profile': 'invalidProfile', 'env-config': 'envConfig' }, code);
}

export function approvalLabel(t: TFunction, mode: string): string {
  return codeLabel(t, 'approval', { inherit: 'inherit' }, mode);
}
