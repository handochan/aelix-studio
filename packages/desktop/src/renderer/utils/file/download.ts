/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getBaseUrl, resolveCoreCsrfToken } from '@/common/adapter/httpBridge';
import type { ChatFileRef } from '@/common/types/chatFile';
import { base64ToBlob, BINARY_MIME_MAP } from './base64';
import { buildFileStreamUrl } from './fileUrls';

const BINARY_CONTENT_TYPE = 'application/octet-stream';

async function supportsBinaryContentPost(baseUrl: string): Promise<boolean> {
  try {
    // Query the running Host. A Host replacement at the same origin must not
    // inherit a cached capability from a different release.
    const response = await fetch(`${baseUrl}/api/system/info`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const info: { data?: { file_content_binary_post?: boolean } } = await response.json();
    return info?.data?.file_content_binary_post === true;
  } catch {
    return false;
  }
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
