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

  it('admits the seven families and refuses SVG and HTML by name', () => {
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
    ]) {
      expect(isAllowedMediaType(type), type).toBe(true);
    }
    for (const type of [
      'image/svg+xml',
      'text/html',
      'application/xhtml+xml',
      'application/octet-stream',
    ]) {
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
  it('refuses SVG and HTML declared as themselves as type_not_allowed', () => {
    expect(judge('image/svg+xml', SVG)).toEqual({ ok: false, rejectionCode: 'type_not_allowed' });
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
