import { Readable } from 'node:stream';
import { StreamableFile } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  inlineDisposition,
  respondWithDownload,
  sendDownload,
} from './download-response.js';
import { respondWithPreview } from './preview-response.js';

describe('attachmentDisposition', () => {
  it('is always an attachment, with an ASCII fallback and an RFC 5987 real name', () => {
    expect(attachmentDisposition('brief.pdf')).toBe(
      `attachment; filename="brief.pdf"; filename*=UTF-8''brief.pdf`,
    );
  });

  it('cannot be split or ended by the name: CR, LF, quotes, backslashes, semicolons are replaced', () => {
    const header = attachmentDisposition('re"port;\r\nX-Injected: 1\\.pdf');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="re_port___X-Injected: 1_.pdf"; ')).toBe(true);
    // The real name survives, percent-encoded, where a header cannot be broken by it.
    expect(header).toContain(`filename*=UTF-8''re%22port%3B%0D%0AX-Injected%3A%201%5C.pdf`);
  });

  it('carries a non-ASCII name only in the encoded form, and never an empty fallback', () => {
    const header = attachmentDisposition('نسخة (final)*.pdf');
    expect(header).toContain('filename="____ (final)*.pdf"');
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/);
    expect(header).toContain('%28final%29%2A.pdf');
    expect(attachmentDisposition('""')).toContain('filename="__"');
    expect(attachmentDisposition('')).toContain('filename="download"');
  });

  it('has an inline twin made safe the same way', () => {
    expect(inlineDisposition('clip"\r\n.mp4')).toBe(
      `inline; filename="clip___.mp4"; filename*=UTF-8''clip%22%0D%0A.mp4`,
    );
  });
});

describe('respondWithDownload', () => {
  it('writes the download headers and returns a StreamableFile of the gated stream', () => {
    const written: Record<string, string> = {};
    const stream = Readable.from([Buffer.from('abc')]);
    const file = respondWithDownload(
      {
        stream,
        mimeType: 'application/pdf',
        sizeBytes: 3,
        fileName: 'a.pdf',
        scanStatus: 'clean',
        disposition: 'attachment',
      },
      { header: (name, value) => (written[name] = value) },
    );
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getStream()).toBe(stream);
    expect(written).toEqual({
      'content-type': 'application/pdf',
      'content-length': '3',
      'content-disposition': `attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
      'accept-ranges': 'bytes',
      'x-scan-status': 'clean',
    });
  });

  it('answers 206 with Content-Range and the range length for an honoured range, inline when asked', () => {
    const written: Record<string, string> = {};
    let status = 0;
    let sent: unknown;
    const stream = Readable.from([Buffer.from('cdef')]);
    sendDownload(
      {
        stream,
        mimeType: 'video/mp4',
        sizeBytes: 100,
        fileName: 'clip.mp4',
        scanStatus: 'clean',
        disposition: 'inline',
        range: { start: 10, end: 13 },
      },
      {
        header: (name, value) => (written[name] = value),
        status: (code) => (status = code),
        send: (payload) => (sent = payload),
      },
    );
    expect(status).toBe(206);
    expect(sent).toBe(stream);
    expect(written['content-length']).toBe('4');
    expect(written['content-range']).toBe('bytes 10-13/100');
    expect(written['content-disposition']?.startsWith('inline; ')).toBe(true);
  });

  it('answers 200 without Content-Range for the whole file', () => {
    const written: Record<string, string> = {};
    let status = 0;
    sendDownload(
      {
        stream: Readable.from([Buffer.from('x')]),
        mimeType: 'text/plain',
        sizeBytes: 1,
        fileName: 'a.txt',
        scanStatus: 'not_scanned',
        disposition: 'attachment',
      },
      {
        header: (name, value) => (written[name] = value),
        status: (code) => (status = code),
        send: () => undefined,
      },
    );
    expect(status).toBe(200);
    expect(written['content-range']).toBeUndefined();
    expect(written['x-scan-status']).toBe('not_scanned');
  });
});

describe('respondWithPreview', () => {
  it('is inline, sandboxed, nosniff and cached privately for a day', () => {
    const written: Record<string, string> = {};
    const file = respondWithPreview(
      { stream: Readable.from([Buffer.from('<svg/>')]), mimeType: 'image/svg+xml', sizeBytes: 6 },
      { header: (name, value) => (written[name] = value) },
    );
    expect(file).toBeInstanceOf(StreamableFile);
    expect(written).toEqual({
      'content-type': 'image/svg+xml',
      'content-length': '6',
      'content-disposition': 'inline',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, max-age=86400, immutable',
    });
  });
});
