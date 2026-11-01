import { StreamableFile } from '@nestjs/common';
import type { Readable } from 'node:stream';
import { SANDBOX_CSP } from './download-response.js';
import type { HeaderWriter } from './download-response.js';
import type { PreviewContent } from './file-preview.service.js';

/**
 * R4 slice 4 — the headers a derivative carries (SPEC §3.3).
 *
 * - `inline`: the viewer renders it in place. Only types TManage wrote reach here (WebP, PNG,
 *   JPEG, and the sanitised SVG); the service refuses anything else.
 * - `Content-Security-Policy: sandbox; default-src 'none'`: opened as a document — the SVG case —
 *   the bytes get no script, no plugin, no origin and no outside fetch.
 * - `X-Content-Type-Options: nosniff`.
 * - `Cache-Control: private, max-age=86400, immutable`: a derivative's id names one rendering of
 *   one version and is never rewritten under a different meaning, so the browser may keep it for
 *   a day; `private` keeps it out of shared caches.
 */
export function respondWithPreview(content: PreviewContent, reply: HeaderWriter): StreamableFile {
  reply.header('content-type', content.mimeType);
  reply.header('content-length', String(content.sizeBytes));
  reply.header('content-disposition', 'inline');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', SANDBOX_CSP);
  reply.header('cache-control', 'private, max-age=86400, immutable');
  return new StreamableFile(content.stream as Readable, {
    type: content.mimeType,
    length: content.sizeBytes,
  });
}
