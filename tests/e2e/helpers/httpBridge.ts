import http from 'node:http';
import type { Page } from '@playwright/test';

/**
 * HTTP bridge helper for E2E tests.
 *
 * The renderer migrated from IPC `invokeBridge('subscribe-<key>')` to direct
 * HTTP calls against `aioncore` via `fetch('http://127.0.0.1:<port>/api/...')`.
 * The backend port is exposed on `window.__backendPort` by the preload script
 * (`src/preload/main.ts:71`).
 *
 * These helpers drive backend calls from the renderer context (via `page.evaluate`)
 * so tests execute in the same network context the app itself uses — identical
 * port, identical base URL, no host-side HTTP plumbing.
 *
 * Backend responses are wrapped as `{ success, data, ... }`. This helper unwraps
 * `data` when present, matching `httpBridge.ts:76` in the renderer adapter.
 */

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function httpInvoke<T = unknown>(
  page: Page,
  method: HttpMethod,
  path: string,
  body?: unknown
): Promise<T> {
  return page.evaluate(
    async ({ method: m, path: p, body: b }) => {
      const port = (window as unknown as { __backendPort?: number }).__backendPort ?? 13400;
      const url = `http://127.0.0.1:${port}${p}`;
      // DELETE routes require Content-Type: application/json AND a JSON-parseable
      // body even when the operation takes no body (e.g. DELETE /api/skills/external-paths
      // where the path is in the query string). Send `{}` as default body for DELETE.
      const effectiveBody = b !== undefined ? b : m === 'DELETE' ? {} : undefined;
      const headers: Record<string, string> = {};
      if (effectiveBody !== undefined) headers['Content-Type'] = 'application/json';

      const requestInit: RequestInit = {
        method: m,
        headers,
      };
      if (effectiveBody !== undefined && m !== 'GET') {
        requestInit.body = JSON.stringify(effectiveBody);
      }

      const res = await fetch(url, requestInit);

      if (!res.ok) {
        let errText: string;
        try {
          errText = JSON.stringify(await res.json());
        } catch {
          errText = await res.text();
        }
        throw new Error(`Backend ${m} ${p} failed (${res.status}): ${errText}`);
      }

      const contentType = res.headers.get('Content-Type');
      if (!contentType?.includes('application/json')) {
        return undefined;
      }

      const json = await res.json();
      if (json && typeof json === 'object' && 'data' in json) {
        return (json as { data: unknown }).data;
      }
      return json;
    },
    { method, path, body }
  ) as Promise<T>;
}

export const httpGet = <T = unknown>(page: Page, path: string) => httpInvoke<T>(page, 'GET', path);
export const httpPost = <T = unknown>(page: Page, path: string, body?: unknown) =>
  httpInvoke<T>(page, 'POST', path, body);
export const httpDelete = <T = unknown>(page: Page, path: string) => httpInvoke<T>(page, 'DELETE', path);

/** Dial the fixture's loopback listener without relying on the OS to resolve .localhost. */
export function fetchWebUILoopback(
  address: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
): Promise<Response> {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        hostname: '127.0.0.1',
        method: init?.method,
        headers: { ...init?.headers, host: url.host },
        signal: init?.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const headers = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) {
            headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
          }
          resolve(new Response(chunks.length ? Buffer.concat(chunks) : null, { status: response.statusCode, headers }));
        });
      }
    );
    request.once('error', reject);
    request.setTimeout(15000, () => request.destroy(new Error('WebUI response timeout')));
    request.end(init?.body);
  });
}
