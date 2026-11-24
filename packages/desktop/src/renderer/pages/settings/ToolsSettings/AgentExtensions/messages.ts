/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every code the helper or its channel answers, mapped to the screen's own text. The helper's
 * `detail` is plain English for logs and support; the screen shows the text for the code.
 */
const CODES = [
  // Import refusals.
  'NOT_A_WHEEL',
  'INVALID_WHEEL',
  'DIRECT_REFERENCE',
  'NOT_AN_EXTENSION',
  'STARTUP_CODE',
  'BUNDLE_OVERLAP',
  'BUNDLE_VERSION_CONFLICT',
  // Helper failures.
  'INSTALLER_FAILED',
  'INSTALLER_NOT_RUN',
  'GENERATION_MODIFIED',
  'UNSAFE_ROOT',
  'AMBIGUOUS_NAME',
  'UNSUPPORTED_PLATFORM',
  'REQUEST_MISMATCH',
  'LOAD_ERROR',
  'MANAGED_EXTENSION_INVALID',
  'VERIFICATION_FAILED',
  'NO_CHANGE',
  'NOT_INSTALLED',
  'NOTHING_TO_ROLL_BACK',
  'ONLINE_INSTALL_DISABLED',
  'SETTINGS_UNREADABLE',
  'INVALID_PROXY',
  'PROXY_CREDENTIALS_REQUIRED',
  'PROXY_CREDENTIALS_NOT_STORED',
  'PROXY_CREDENTIALS_REJECTED',
  'PROXY_CHANGED',
  'GIT_FETCH_FAILED',
  'SUBDIRECTORY_INVALID',
  'BUNDLE_CHANGED',
  'BUSY',
  'CONFLICT',
  'CANCELLED',
  'TIMEOUT',
  'RUNTIME_UNAVAILABLE',
  'INVALID_INPUT',
  'UNSUPPORTED',
  'NOT_FOUND',
  'INTERNAL',
  // The upgrade.
  'UPGRADE_UNAVAILABLE',
  'UPGRADE_SOURCE_MISMATCH',
  'SHARED_DISTRIBUTION_FILES',
  'UPGRADE_RESPONSE_TOO_LARGE',
  'PINNED',
  'PIN_UNKNOWN',
  // The channel's own answers.
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'FRAME_LIMIT',
  'UNAVAILABLE',
  'CONNECTION_LOST',
  'INSECURE_TRANSPORT',
] as const;

const KNOWN = new Set<string>(CODES);

/** The i18n key of the text for a code; a code the screen does not know reads as unexpected. */
export function failureKey(code: string | undefined): string {
  return `settings.agentExtensions.errors.${code && KNOWN.has(code) ? code : 'UNKNOWN'}`;
}

/** For tests: every code that has its own text. */
export const KNOWN_CODES: readonly string[] = CODES;
