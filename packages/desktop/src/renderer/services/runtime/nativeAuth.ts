import type { NativeAuthCatalog, NativeAuthCommand, NativeAuthReply } from '@aionui/web-host';

export const NATIVE_AUTH_CATALOG_KEY = 'studio.nativeAuth.catalog';

/** ACP uses the provider-qualified identifier, including any slashes in the model ID. */
export const aelixModelId = (provider: string, model: string): string => `${provider}/${model}`;

export async function loadNativeAuthCatalog(): Promise<NativeAuthCatalog | null> {
  const reply = await requestNativeAuth({ action: 'catalog' });
  return reply.ok && 'providers' in reply.data ? reply.data : null;
}

declare global {
  interface Window {
    __studioNativeAuth?: { request: (command: NativeAuthCommand) => Promise<NativeAuthReply> };
  }
}

/** Secret-bearing requests bypass generic HTTP logging, interceptors and automatic replay. */
export async function requestNativeAuth(command: NativeAuthCommand): Promise<NativeAuthReply> {
  try {
    if (window.__studioNativeAuth) return await window.__studioNativeAuth.request(command);
    const response = await fetch('/api/studio/native-auth', {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Auth': '1' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(25000),
    });
    if (!response.ok) return { ok: false, code: response.status === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE' };
    return (await response.json()) as NativeAuthReply;
  } catch {
    // A lost response may follow a committed mutation. Never replay credentials.
    return { ok: false, code: 'CONNECTION_LOST' };
  }
}
