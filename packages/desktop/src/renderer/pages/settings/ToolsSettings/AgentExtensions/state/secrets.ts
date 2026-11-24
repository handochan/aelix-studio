/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionSource, StudioExtensionsRequest } from '@aionui/web-host';

/**
 * Whether a URL or address may carry a user name, password or token: any `@` in it, wherever it
 * stands (2026-11-24 orchestrator decision: fail-safe, no parsing to get around). A plain
 * `git@host:repo` is taken as one too.
 */
export const hasUserPart = (url: string | null | undefined): boolean => typeof url === 'string' && url.includes('@');

/** The usual `scheme://user[:password]@` part of a URL. */
const USER_PART = /^([^:/?#]*:\/\/)[^/?#]*@/;

/**
 * `url` with nothing that may be a user part left: the usual user part taken out, or, when an
 * `@` is still there after that (an address written another way), nothing at all.
 */
export const withoutUserPart = (url: string): string => {
  const stripped = url.trim().replace(USER_PART, '$1');
  return stripped.includes('@') ? '' : stripped;
};

/** Whether an install source names a URL that may carry a user part (Git, or a package index). */
export function sourceHasUserPart(source: ExtensionSource): boolean {
  if (source.kind === 'file') return false;
  return hasUserPart(source.indexUrl) || (source.kind === 'git' && hasUserPart(source.url));
}

/**
 * Whether a request carries a secret: proxy credentials, or a URL or address that may carry a
 * user part (a Git or index URL of an install, the proxy address of `set_settings`). The channel
 * decides by this alone, so a request that carries one cannot take another way out.
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
