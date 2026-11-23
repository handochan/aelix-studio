/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionSource, StudioExtensionsRequest } from '@aionui/web-host';

/** A URL with a user part (`scheme://user[:password]@host…`): a user name alone can be a token. */
const USER_PART = /^([^:/?#]*:\/\/)[^/?#]*@/;

/** Whether `url` carries a user name or password. */
export const hasUserPart = (url: string | null | undefined): boolean =>
  typeof url === 'string' && USER_PART.test(url.trim());

/** `url` with its user name and password taken out. */
export const withoutUserPart = (url: string): string => url.replace(USER_PART, '$1');

/** Whether an install source names a URL with a user part (Git, or a package index). */
export function sourceHasUserPart(source: ExtensionSource): boolean {
  if (source.kind === 'file') return false;
  return hasUserPart(source.indexUrl) || (source.kind === 'git' && hasUserPart(source.url));
}

/**
 * Whether a request carries a secret: proxy credentials, or a URL with a user part (a Git or
 * index URL of an install, the proxy address of `set_settings`). The channel decides by this
 * alone, so a request that carries one cannot take another way out.
 */
export function carriesSecret(command: StudioExtensionsRequest): boolean {
  const request = command as StudioExtensionsRequest & {
    proxyCredentials?: unknown;
    credentials?: unknown;
    source?: ExtensionSource;
    settings?: { proxy?: string | null };
  };
  if (request.proxyCredentials !== undefined || request.credentials !== undefined) return true;
  if (request.action === 'install' && request.source) return sourceHasUserPart(request.source);
  if (request.action === 'set_settings') return hasUserPart(request.settings?.proxy);
  return false;
}
