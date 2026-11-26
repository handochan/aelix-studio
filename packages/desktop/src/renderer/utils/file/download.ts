/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getBaseUrl, resolveCoreCsrfToken } from '@/common/adapter/httpBridge';
import { refreshSession } from '@/common/adapter/sessionRefresh';
import type { ChatFileRef } from '@/common/types/chatFile';
import { base64ToBlob, BINARY_MIME_MAP } from './base64';
import { buildFileStreamUrl } from './fileUrls';

const BINARY_CONTENT_TYPE = 'application/octet-stream';

type SystemInfo = {
  success?: boolean;
  data?: { platform?: string; arch?: string; file_content_binary_post?: boolean };
};

async function supportsBinaryContentPost(baseUrl: string): Promise<boolean> {
  // Check the running Host on each attempt, including after a session refresh.
  const requestSystemInfo = () =>
    fetch(`${baseUrl}/api/system/info`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2000) });

  try {
    let response = await requestSystemInfo();
    if (response.status === 401 && (await refreshSession())) {
      response = await requestSystemInfo();
    }
    const info: SystemInfo | null = response.ok ? await response.json() : null;
    const data = info?.data;
    const capability = data?.file_content_binary_post;
    if (
      info?.success === true &&
      typeof data?.platform === 'string' &&
      typeof data.arch === 'string' &&
      (capability === undefined || typeof capability === 'boolean')
    ) {
      return capability === true;
    }
  } catch {
    // Report the same download failure for transport, timeout and JSON errors.
  }
  throw new Error('File download could not be started');
}

async function fetchBinaryContent(baseUrl: string, file: ChatFileRef): Promise<Response> {
  const headers = new Headers({ Accept: BINARY_CONTENT_TYPE, 'Content-Type': 'application/json' });
  const csrf = resolveCoreCsrfToken();
  if (csrf) headers.set('x-csrf-token', csrf);
  return fetch(`${baseUrl}/api/fs/content`, { method: 'POST', headers, body: JSON.stringify({ file }) });
}

function triggerBlobDownload(blob: Blob, file_name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file_name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Download a file by reading its raw bytes from disk (works in both Electron and WebUI).
 * Uses getImageBase64 + in-memory atob decode to bypass CSP connect-src restrictions.
 */
export async function downloadFileFromPath(file_path: string, file_name: string, workspace?: string): Promise<void> {
  const dataUrl = await ipcBridge.fs.getImageBase64.invoke({ path: file_path, workspace });
  if (!dataUrl) {
    throw new Error('File data not found');
  }
  const ext = file_name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = BINARY_MIME_MAP[ext] ?? 'application/octet-stream';
  const blob = base64ToBlob(dataUrl, mimeType);
  triggerBlobDownload(blob, file_name);
}

/**
 * Download a file addressed by its renderer-safe file reference.
 *
 * Hosts that advertise binary POST accept the file reference in the request
 * body. Older Hosts use the existing raw GET for files of every size.
 */
export async function downloadFileFromRef(file: ChatFileRef, file_name: string): Promise<void> {
  const baseUrl = getBaseUrl();
  const supportsPost = await supportsBinaryContentPost(baseUrl);
  const response = supportsPost ? await fetchBinaryContent(baseUrl, file) : await fetch(buildFileStreamUrl(file));
  if (!response.ok) throw new Error(`File download failed (${response.status})`);
  if (supportsPost && response.headers.get('Content-Type') !== BINARY_CONTENT_TYPE) {
    throw new Error('Unexpected file download format');
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('File data is empty');
  triggerBlobDownload(blob, file_name);
}

/**
 * Download in-memory text content as a file.
 */
export function downloadTextContent(content: string, file_name: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  triggerBlobDownload(blob, file_name);
}
