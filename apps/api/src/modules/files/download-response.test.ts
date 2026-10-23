import { Readable } from 'node:stream';
import { StreamableFile } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { attachmentDisposition, respondWithDownload } from './download-response.js';

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
});

describe('respondWithDownload', () => {
  it('writes the six headers and returns a StreamableFile of the gated stream', () => {
    const written: Record<string, string> = {};
    const stream = Readable.from([Buffer.from('abc')]);
    const file = respondWithDownload(
      { stream, mimeType: 'application/pdf', sizeBytes: 3, fileName: 'a.pdf', scanStatus: 'clean' },
      { header: (name, value) => (written[name] = value) },
    );
    expect(file).toBeInstanceOf(StreamableFile);
    expect(file.getStream()).toBe(stream);
    expect(written).toEqual({
      'content-type': 'application/pdf',
      'content-length': '3',
      'content-disposition': `attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'x-scan-status': 'clean',
    });
  });
});
