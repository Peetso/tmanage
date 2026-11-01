import { describe, expect, it } from 'vitest';
import {
  TextualCheck,
  isAllowedMediaType,
  judgeContentType,
  looksLikeMarkup,
  normalizeMediaType,
} from './content-signature.js';

/**
 * The judge, as SEC-06 would attack it: spoofed labels, active content under an image
 * label, a polyglot, a NUL in "text", and the family rule that keeps a real Office document
 * from being refused for being a ZIP.
 */

const OOXML = 'application/vnd.openxmlformats-officedocument';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj', 'latin1');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
const HTML = Buffer.from('\n  <!DOCTYPE html><html><script>alert(1)</script></html>');

/** A text check that has seen the whole object. */
function textual(...chunks: Buffer[]): TextualCheck {
  const check = new TextualCheck();
  for (const chunk of chunks) check.update(chunk);
  return check;
}

const judge = (declared: string, head: Buffer) => judgeContentType(declared, head, textual(head));

describe('normalizeMediaType and the allowlist', () => {
  it('lowercases and drops parameters before comparing', () => {
    expect(normalizeMediaType('APPLICATION/PDF; charset=utf-8')).toBe('application/pdf');
    expect(normalizeMediaType('  Image/PNG ')).toBe('image/png');
  });

  it('admits the allowlisted families by name and refuses HTML and unknown types', () => {
    for (const type of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/zip',
      `${OOXML}.wordprocessingml.document`,
      'text/plain',
      'text/csv; header=present',
      'image/svg+xml',
      'image/heic',
      'image/tiff',
      'image/vnd.adobe.photoshop',
      'application/illustrator',
      'application/postscript',
      'video/mp4',
      'video/quicktime',
      'audio/mpeg',
      'audio/wav',
      'audio/mp4',
      'audio/ogg',
      'audio/flac',
    ]) {
      expect(isAllowedMediaType(type), type).toBe(true);
    }
    for (const type of ['text/html', 'application/xhtml+xml', 'application/octet-stream']) {
      expect(isAllowedMediaType(type), type).toBe(false);
    }
  });
});

describe('judgeContentType — the signature at offset zero', () => {
  it('admits each binary family by its own signature and records the canonical type', () => {
    expect(judge('application/pdf', PDF)).toEqual({
      ok: true,
      detectedMimeType: 'application/pdf',
      detectedType: 'pdf',
    });
    expect(judge('image/png', PNG)).toMatchObject({ ok: true, detectedType: 'png' });
    expect(judge('image/jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      ok: true,
      detectedMimeType: 'image/jpeg',
      detectedType: 'jpeg',
    });
    expect(judge('image/gif', Buffer.from('GIF89a\x01\x00'))).toMatchObject({
      detectedType: 'gif',
    });
    expect(judge('image/webp', Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '))).toMatchObject({
      detectedType: 'webp',
    });
  });

  it('admits an Office document as its declared member of the ZIP family, never as a mismatch', () => {
    // Reversal: compare the declared type to the sniffed one by equality and every real
    // .docx is refused as `type_mismatch`.
    expect(judge(`${OOXML}.wordprocessingml.document`, ZIP)).toEqual({
      ok: true,
      detectedMimeType: `${OOXML}.wordprocessingml.document`,
      detectedType: 'docx',
    });
    expect(judge(`${OOXML}.spreadsheetml.sheet`, ZIP)).toMatchObject({ detectedType: 'xlsx' });
    expect(judge('application/zip', ZIP)).toMatchObject({ detectedType: 'zip' });
  });

  it('refuses a spoofed label as type_mismatch: PNG bytes declared PDF, and the reverse', () => {
    expect(judge('application/pdf', PNG)).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
    expect(judge('image/png', PDF)).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
    // An empty archive is not a document.
    expect(judge('application/zip', Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
  });

  it('refuses a polyglot whose real header is not at offset zero', () => {
    // Reversal: search the window for `%PDF-` instead of matching at zero and this passes.
    const polyglot = Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.alloc(600),
      Buffer.from('%PDF-1.4'),
    ]);
    expect(judge('application/pdf', polyglot)).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    expect(judge('image/gif', polyglot)).toMatchObject({ ok: true, detectedType: 'gif' });
  });

  it('refuses a zero-byte object as a mismatch for any declared family', () => {
    expect(judge('application/pdf', Buffer.alloc(0))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    expect(judge('text/plain', Buffer.alloc(0))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
  });
});

describe('judgeContentType — active content is refused first, whatever the label', () => {
  it('refuses HTML declared as itself as type_not_allowed', () => {
    expect(judge('text/html', HTML)).toEqual({ ok: false, rejectionCode: 'type_not_allowed' });
  });

  it('refuses SVG declared as image/png as type_not_allowed — for what it is, not for the disagreement', () => {
    // Reversal: consult the family before the markup check and this is `type_mismatch`,
    // which hides that active content reached quarantine (SEC-06).
    expect(judge('image/png', SVG)).toEqual({ ok: false, rejectionCode: 'type_not_allowed' });
    expect(judge('application/pdf', HTML)).toEqual({
      ok: false,
      rejectionCode: 'type_not_allowed',
    });
  });

  it('refuses markup declared as text, even behind a BOM, whitespace, or a heading', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  \n<svg/>')]);
    expect(judge('text/plain', bom)).toEqual({ ok: false, rejectionCode: 'type_not_allowed' });
    const buried = Buffer.from('# Notes\n\nSome prose, then <script>fetch("x")</script>');
    expect(judge('text/markdown', buried)).toEqual({
      ok: false,
      rejectionCode: 'type_not_allowed',
    });
  });

  it('does not apply the deep marker scan to a binary family that carries its signature', () => {
    // A PDF's metadata packet may legitimately contain `<?xml`; its `%PDF-` header is the proof.
    const pdf = Buffer.concat([PDF, Buffer.from('\n<?xpacket begin=""?><?xml version="1.0"?>')]);
    expect(judge('application/pdf', pdf)).toMatchObject({ ok: true, detectedType: 'pdf' });
    expect(looksLikeMarkup(pdf, false)).toBe(false);
    expect(looksLikeMarkup(pdf, true)).toBe(true);
  });
});

/** An ISO base media header: a 24-byte `ftyp` box with `brand` as its major brand. */
function ftyp(brand: string): Buffer {
  const head = Buffer.alloc(32);
  head.writeUInt32BE(24, 0);
  head.write('ftyp', 4, 'latin1');
  head.write(brand, 8, 'latin1');
  head.write('isom', 16, 'latin1');
  return head;
}

const R4_FAMILIES: readonly (readonly [string, Buffer, string, string])[] = [
  // [declared, head, detectedType, detectedMimeType]
  ['image/heic', ftyp('heic'), 'heic', 'image/heic'],
  ['image/heif', ftyp('mif1'), 'heif', 'image/heif'],
  ['image/tiff', Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]), 'tiff', 'image/tiff'],
  ['image/tif', Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]), 'tiff', 'image/tiff'],
  [
    'image/vnd.adobe.photoshop',
    Buffer.from([...Buffer.from('8BPS'), 0x00, 0x01, 0, 0]),
    'psd',
    'image/vnd.adobe.photoshop',
  ],
  [
    'application/x-photoshop',
    Buffer.from([...Buffer.from('8BPS'), 0x00, 0x02, 0, 0]),
    'psd',
    'image/vnd.adobe.photoshop',
  ],
  ['application/illustrator', PDF, 'ai', 'application/pdf'],
  [
    'application/postscript',
    Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n'),
    'eps',
    'application/postscript',
  ],
  [
    'image/x-eps',
    Buffer.from([0xc5, 0xd0, 0xd3, 0xc6, 30, 0, 0, 0]),
    'eps',
    'application/postscript',
  ],
  ['video/mp4', ftyp('isom'), 'mp4', 'video/mp4'],
  ['video/mp4', ftyp('mp42'), 'mp4', 'video/mp4'],
  ['video/quicktime', ftyp('qt  '), 'mov', 'video/quicktime'],
  ['audio/x-m4a', ftyp('M4A '), 'm4a', 'audio/mp4'],
  ['audio/mpeg', Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1'), 'mp3', 'audio/mpeg'],
  ['audio/mpeg', Buffer.from([0xff, 0xfb, 0x90, 0x64]), 'mp3', 'audio/mpeg'],
  ['audio/x-wav', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1'), 'wav', 'audio/wav'],
  ['audio/ogg', Buffer.from('OggS\x00\x02', 'latin1'), 'ogg', 'audio/ogg'],
  ['audio/flac', Buffer.from('fLaC\x00\x00\x00\x22', 'latin1'), 'flac', 'audio/flac'],
];

describe('R4 proofing families — each admitted by its own signature at offset zero', () => {
  it('admits every new family and records the canonical type', () => {
    for (const [declared, head, detectedType, detectedMimeType] of R4_FAMILIES) {
      expect(judge(declared, head), declared).toEqual({ ok: true, detectedMimeType, detectedType });
    }
  });

  it('refuses each new family when the signature is one byte later', () => {
    // Reversal: search the window instead of matching at zero and each of these passes.
    for (const [declared, head] of R4_FAMILIES) {
      const shifted = Buffer.concat([Buffer.from([0x00]), head]);
      expect(judge(declared, shifted), declared).toEqual({
        ok: false,
        rejectionCode: 'type_mismatch',
      });
    }
  });

  it('tells HEIC from MP4 by the major brand, so an ftyp file has one family', () => {
    // Reversal: match `ftyp` alone and a video labelled image/heic is admitted as a photo.
    expect(judge('image/heic', ftyp('isom'))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    expect(judge('video/mp4', ftyp('heic'))).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
    // An unknown brand, and an ftyp box too short to hold one, are refused.
    expect(judge('video/mp4', ftyp('xxxx'))).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
    const short = ftyp('isom');
    short.writeUInt32BE(8, 0);
    expect(judge('video/mp4', short)).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
  });

  it('refuses spoofed labels and polyglots across the new families', () => {
    expect(judge('audio/mpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    expect(judge('audio/wav', Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1'))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    // A PSD whose version is neither 1 nor 2 is not a Photoshop document.
    expect(
      judge('image/vnd.adobe.photoshop', Buffer.from([...Buffer.from('8BPS'), 0x00, 0x07])),
    ).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
    // A GIF with an `8BPS` buried after it is a GIF, not a PSD.
    const polyglot = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64), Buffer.from('8BPS')]);
    expect(judge('image/vnd.adobe.photoshop', polyglot)).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    // An AAC ADTS stream (layer 00) is not MP3.
    expect(judge('audio/mpeg', Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    // A legacy PostScript Illustrator file is refused, not admitted as a PDF.
    expect(judge('application/illustrator', Buffer.from('%!PS-Adobe-3.0\n'))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
  });
});

describe('R4 SVG — the one markup family, admitted only as itself', () => {
  const svgWith = (text: string) => Buffer.from(text, 'utf8');

  it('admits an SVG declared as image/svg+xml, bare or behind a prologue', () => {
    for (const text of [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
      '﻿  \n<svg>\n</svg>',
      '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Generator: Illustrator -->\n<svg version="1.1">',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd"><svg/>',
      '<!-- made by hand --><svg width="1"></svg>',
    ]) {
      const head = svgWith(text);
      expect(judge('image/svg+xml', head), text).toEqual({
        ok: true,
        detectedMimeType: 'image/svg+xml',
        detectedType: 'svg',
      });
    }
    expect(judge('image/svg+xml', SVG)).toMatchObject({ ok: true, detectedType: 'svg' });
  });

  it('refuses SVG under any other label — the relaxation is for the declared type only', () => {
    // Reversal: skip the markup refusal whenever the bytes look like SVG and this passes.
    for (const declared of ['image/png', 'text/plain', 'application/pdf', 'image/heic']) {
      expect(judge(declared, SVG), declared).toEqual({
        ok: false,
        rejectionCode: 'type_not_allowed',
      });
    }
  });

  it('still refuses HTML, even declared as SVG or wrapping an SVG', () => {
    expect(judge('image/svg+xml', HTML)).toEqual({ ok: false, rejectionCode: 'type_not_allowed' });
    expect(judge('image/svg+xml', svgWith('<html><body><svg/></body></html>'))).toEqual({
      ok: false,
      rejectionCode: 'type_not_allowed',
    });
    expect(
      judge('image/svg+xml', svgWith('<svg><foreignObject><html><script/></html></foreignObject>')),
    ).toEqual({ ok: false, rejectionCode: 'type_not_allowed' });
    expect(judge('text/html', svgWith('<svg/>'))).toEqual({
      ok: false,
      rejectionCode: 'type_not_allowed',
    });
  });

  it('refuses SVG-labelled bytes that are not an SVG document as a mismatch', () => {
    expect(judge('image/svg+xml', PNG)).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
    expect(judge('image/svg+xml', svgWith('<?xml version="1.0"?><rss/>'))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    expect(judge('image/svg+xml', svgWith('<svgfoo/>'))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    expect(judge('image/svg+xml', svgWith('hello <svg/>'))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    // The whole object must be text: a NUL later in an "SVG" refuses it.
    const head = svgWith('<svg/>');
    expect(judgeContentType('image/svg+xml', head, textual(head, Buffer.from([0x00])))).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
  });
});

describe('the textual rule is a whole-object rule', () => {
  it('admits UTF-8 text with a BOM and multi-byte characters split across chunks', () => {
    const text = Buffer.from('﻿اسم الملف — résumé ✓\n', 'utf8');
    // Split inside the four-byte check mark so the decoder must carry bytes between chunks.
    const cut = text.length - 3;
    const check = textual(text.subarray(0, cut), text.subarray(cut));
    expect(check.ok()).toBe(true);
    expect(judgeContentType('text/plain', text.subarray(0, 64), check)).toEqual({
      ok: true,
      detectedMimeType: 'text/plain',
      detectedType: 'text_plain',
    });
  });

  it('refuses a NUL byte anywhere, and invalid UTF-8 anywhere, as type_mismatch', () => {
    const head = Buffer.from('a,b,c\n1,2,3\n');
    const nul = textual(head, Buffer.from([0x00, 0x41]));
    expect(judgeContentType('text/csv', head, nul)).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    // Reversal: judge text by the head alone and a binary tail rides in as CSV.
    const invalid = textual(head, Buffer.from([0xc3]), Buffer.from([0x28]));
    expect(judgeContentType('text/csv', head, invalid)).toEqual({
      ok: false,
      rejectionCode: 'type_mismatch',
    });
    // A sequence left unfinished at the end of the object is invalid too.
    const truncated = textual(head, Buffer.from([0xe2, 0x9c]));
    expect(truncated.ok()).toBe(false);
  });

  it('refuses a text label on binary bytes as type_mismatch', () => {
    expect(judge('text/plain', PNG)).toEqual({ ok: false, rejectionCode: 'type_mismatch' });
  });
});
