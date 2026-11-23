import { ApiError } from '../../common/http/errors.js';

/**
 * Fix lane C (2026-11-23, G5) — a small file sent inline as base64 (`POST …/work-items/:workItemId
 * /inline-files`, the AI's upload door). Parsing only: the bytes then go through the upload's own
 * checks (`CloudImportService.importInlineToWorkItem` → `FilesService.importFetched`). Kept out of
 * the controller file so the AI registry can name the same limits without importing a controller.
 */

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

/**
 * Fix lane C (2026-11-23, G5). The largest inline file: 512 KiB decoded, so the base64 body stays
 * well inside Fastify's 1 MiB `bodyLimit`. The company's own (smaller or larger) cap still applies.
 */
export const INLINE_FILE_MAX_BYTES = 512 * 1024;

/** The types an inline file may declare. The verifier still checks the bytes against the type. */
export const INLINE_FILE_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A plain file name: 1–255 characters, no path separator, no control character. */
function isPlainFileName(name: string): boolean {
  if (name.length < 1 || name.length > 255 || name === '.' || name === '..') return false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '/' || char === '\\' || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export function inlineFile(
  body:
    | { readonly name?: unknown; readonly mimeType?: unknown; readonly contentBase64?: unknown }
    | undefined,
): { readonly name: string; readonly mimeType: string; readonly bytes: Buffer } {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!isPlainFileName(name)) {
    throw invalid('name', 'must be a plain file name of 1-255 characters');
  }
  const mimeType = typeof body?.mimeType === 'string' ? body.mimeType : '';
  if (!INLINE_FILE_TYPES.includes(mimeType)) {
    throw invalid('mimeType', `must be one of ${INLINE_FILE_TYPES.join(', ')}`);
  }
  const content = typeof body?.contentBase64 === 'string' ? body.contentBase64 : '';
  if (content === '' || content.length % 4 !== 0 || !BASE64.test(content)) {
    throw invalid('contentBase64', 'must be standard base64');
  }
  // 4 base64 characters carry 3 bytes: refuse an oversized body before decoding it.
  if ((content.length / 4) * 3 > INLINE_FILE_MAX_BYTES + 2) {
    throw invalid(
      'contentBase64',
      `must decode to ${String(INLINE_FILE_MAX_BYTES)} bytes or fewer`,
    );
  }
  const bytes = Buffer.from(content, 'base64');
  if (bytes.length === 0) throw invalid('contentBase64', 'must not be empty');
  if (bytes.length > INLINE_FILE_MAX_BYTES) {
    throw invalid(
      'contentBase64',
      `must decode to ${String(INLINE_FILE_MAX_BYTES)} bytes or fewer`,
    );
  }
  return { name, mimeType, bytes };
}
