/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** MIME type map keyed by lowercase file extension, for binary file downloads. */
export const BINARY_MIME_MAP: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  odp: 'application/vnd.oasis.opendocument.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  bz2: 'application/x-bzip2',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
};

/**
 * Decode a base64 data URL into a Blob.
 *
 * Uses in-memory atob() decoding instead of fetch() to avoid CSP connect-src
 * restrictions that block `fetch('data:...')` in WebUI mode.
 */
export function base64ToBlob(dataUrl: string, mimeType: string): Blob {
  const base64 = dataUrl.split(',')[1] ?? '';
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

const MIME_TOKEN = /^[\w!#$%&'*+.^`|~-]+$/;

/** Check data URL syntax before passing a preview source to Chromium. */
export function isValidImageSource(source: string): boolean {
  try {
    // URL parsing normalizes the scheme but does not validate the data payload.
    const url = new URL(source, document.baseURI);
    if (url.protocol !== 'data:') return true;
    const data = url.href.slice('data:'.length).split('#', 1)[0];
    const comma = data.indexOf(',');
    if (comma < 0) return false;
    const payload = data.slice(comma + 1);
    if (!payload) return false;

    const [mime, ...params] = data
      .slice(0, comma)
      .split(';')
      .map((part) => part.trim());
    const mediaType = mime.split('/');
    if (mime && (mediaType.length !== 2 || !mediaType.every((part) => MIME_TOKEN.test(part)))) return false;
    // Chromium requires charset to be a token but accepts other parameters
    // with quoted values. Non-base64 payloads may contain a literal '%'.
    if (params.some((param) => /^charset=/i.test(param) && !MIME_TOKEN.test(param.slice('charset='.length)))) {
      return false;
    }
    if (!params.some((param) => param.toLowerCase() === 'base64')) return true;

    // Match forgiving base64 decoding without allocating a decoded image.
    const encoded = (payload.includes('%') ? decodeURIComponent(payload) : payload).replace(/[ \t\r\n\f]/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    return encoded.endsWith('=') ? encoded.length % 4 === 0 : encoded.length % 4 !== 1;
  } catch {
    return false;
  }
}
