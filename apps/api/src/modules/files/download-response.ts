import { StreamableFile } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { FileDownload } from './file-download.service.js';

/**
 * The response headers a file download carries, and the one place they are written.
 *
 * `26-THREAT-MODELS` §5 names content-disposition XSS and spoofed MIME among the file
 * threats and "forced safe disposition" among the controls; `04-SECURITY-PRIVACY` §6 asks for
 * a safe `Content-Disposition`. No planning line fixes the values, so they are a recorded
 * decision (`docs/implementation-status.md`, slice C):
 *
 * - `attachment`, never `inline` — the browser saves, it does not render. A PDF's XMP, an
 *   SVG-in-disguise or a polyglot cannot become a document in the tenant's origin.
 * - the **detected** type, never the declared one — the verifier's signature is the fact.
 * - `X-Content-Type-Options: nosniff` — the browser is told not to second-guess it.
 * - `Cache-Control: private, no-store` — no shared cache, no disk copy (`27` SEC-05).
 * - `Content-Length` — the version's size, held to the object's before the first byte.
 *
 * The filename is the asset's name, made safe two ways: an ASCII fallback with quotes,
 * backslashes, semicolons, separators and every control byte replaced, and an RFC 5987
 * `filename*` carrying the real name percent-encoded — a name with a CR/LF in it cannot
 * split the header, and a name with a quote cannot end the parameter.
 */
export interface HeaderWriter {
  header(name: string, value: string): unknown;
}

export function attachmentDisposition(fileName: string): string {
  return `attachment; filename="${asciiFallback(fileName)}"; filename*=UTF-8''${rfc5987(fileName)}`;
}

export function respondWithDownload(download: FileDownload, reply: HeaderWriter): StreamableFile {
  reply.header('content-type', download.mimeType);
  reply.header('content-length', String(download.sizeBytes));
  reply.header('content-disposition', attachmentDisposition(download.fileName));
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
  // B3. `clean`, or `not_scanned` for a file served before its virus scan (owner policy).
  reply.header('x-scan-status', download.scanStatus);
  return new StreamableFile(download.stream as Readable, {
    type: download.mimeType,
    length: download.sizeBytes,
  });
}

function asciiFallback(name: string): string {
  let out = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    const printable = code >= 0x20 && code <= 0x7e;
    const unsafe = ch === '"' || ch === '\\' || ch === ';' || ch === '/';
    out += printable && !unsafe ? ch : '_';
  }
  return out.length === 0 ? 'download' : out;
}

function rfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
