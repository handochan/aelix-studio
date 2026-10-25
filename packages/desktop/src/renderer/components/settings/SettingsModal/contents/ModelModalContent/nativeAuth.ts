import type { NativeAuthCommand, NativeAuthReply } from '@aionui/web-host';

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
