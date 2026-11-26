/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getBaseUrl, resolveCoreCsrfToken } from '@/common/adapter/httpBridge';
import type { ChatFileRef } from '@/common/types/chatFile';
import { base64ToBlob, BINARY_MIME_MAP, decodeBase64Blob } from './base64';

const BINARY_CONTENT_TYPE = 'application/octet-stream';

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
 * Send the file identity in the body so Chromium's failed-request URLs never
 * expose it. Older Hosts answer the same request with their JSON base64 envelope.
 */
export async function downloadFileFromRef(file: ChatFileRef, file_name: string): Promise<void> {
  const headers = new Headers({ Accept: BINARY_CONTENT_TYPE, 'Content-Type': 'application/json' });
  const csrf = resolveCoreCsrfToken();
  if (csrf) headers.set('x-csrf-token', csrf);
  const response = await fetch(`${getBaseUrl()}/api/fs/content`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file, encoding: 'base64' }),
  });
  if (!response.ok) throw new Error(`File download failed (${response.status})`);
  let blob: Blob;
  if (response.headers.get('Content-Type') === BINARY_CONTENT_TYPE) {
    blob = await response.blob();
  } else {
    const result: { success?: boolean; data?: unknown } = await response.json();
    if (!result?.success || typeof result.data !== 'string') throw new Error('File data not found');
    const ext = file_name.split('.').pop()?.toLowerCase() ?? '';
    blob = decodeBase64Blob(result.data, BINARY_MIME_MAP[ext] ?? BINARY_CONTENT_TYPE);
  }
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
