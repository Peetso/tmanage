import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEXT_LIMITS,
  DOCX_MIME,
  PDF_MIME,
  PPTX_MIME,
  XLSX_MIME,
  extractText,
  textMimeTypes,
} from './file-text-extractors.js';

/** 62-23 — plain text out of files, with the plan's caps (20 MB, 200 pages, 60 s). */

/** A stored (method 0) ZIP: enough for the reader, no compression needed in a test. */
function zip(files: Readonly<Record<string, string>>): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));

const ARABIC = String.fromCodePoint(0x645, 0x648, 0x62c, 0x632); // a short MSA word

function word(pages: readonly string[]): Uint8Array {
  const body = pages
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  return zip({ 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>` });
}

describe('text extraction (62-23)', () => {
  it('reads plain text, Markdown and HTML (scripts and tags removed)', () => {
    expect(extractText(utf8(`Brief\r\n\r\n\r\n${ARABIC}  \n`), 'text/plain')).toEqual({
      status: 'ready',
      text: `Brief\n\n${ARABIC}`,
      pages: null,
      truncated: false,
      extractor: 'plain',
    });
    const html = extractText(
      utf8('<p>Hello &amp; welcome</p><script>steal()</script><div>Next</div>'),
      'text/html',
    );
    expect(html).toMatchObject({ status: 'ready', text: 'Hello & welcome\n Next' });
    expect(extractText(utf8(`a${String.fromCodePoint(0)}b`), 'text/plain')).toMatchObject({
      status: 'failed',
      code: 'not_text',
    });
  });

  it('reads Word paragraphs and page breaks, and cuts at the page cap', () => {
    const doc = extractText(word(['One &amp; only', 'Two', 'Three']), DOCX_MIME);
    expect(doc).toMatchObject({ status: 'ready', pages: 3, truncated: false, extractor: 'docx' });
    expect(doc.status === 'ready' && doc.text.split('\n').filter(Boolean)).toEqual([
      'One & only',
      'Two',
      'Three',
    ]);
    const capped = extractText(word(['A', 'B', 'C']), DOCX_MIME, {
      ...DEFAULT_TEXT_LIMITS,
      maxPages: 2,
    });
    expect(capped).toMatchObject({ status: 'ready', pages: 3, truncated: true });
    expect(capped.status === 'ready' && capped.text).not.toContain('C');
  });

  it('reads slides in order and sheets with shared, inline and number cells', () => {
    const deck = zip({
      'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Two</a:t></a:r></a:p></p:sld>',
    });
    expect(extractText(deck, PPTX_MIME)).toMatchObject({
      status: 'ready',
      text: 'Slide 1\nTwo\n\nSlide 2\nTen',
      pages: 2,
    });
    const book = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><r><t>Fee</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1250.5</v></c><c r="C2"/></row>' +
        '</sheetData></worksheet>',
    });
    expect(extractText(book, XLSX_MIME)).toMatchObject({
      status: 'ready',
      text: 'Sheet: Budget\nItem\tCost\nFee\t1250.5',
      pages: 1,
      truncated: false,
    });
  });

  it('applies the size, character and time caps as plain outcomes', () => {
    const big = new Uint8Array(DEFAULT_TEXT_LIMITS.maxInputBytes + 1);
    expect(extractText(big, 'text/plain')).toEqual({
      status: 'unsupported',
      code: 'unsupported_too_large',
      extractor: null,
    });
    const long = extractText(utf8(ARABIC.repeat(10)), 'text/plain', {
      ...DEFAULT_TEXT_LIMITS,
      maxChars: 6,
    });
    // Code points, not UTF-16 units or bytes: an Arabic word is cut cleanly.
    expect(long).toMatchObject({ status: 'ready', truncated: true });
    expect(long.status === 'ready' && [...long.text].length).toBe(6);
    let now = 0;
    const slow = extractText(
      word(['a', 'b', 'c']),
      DOCX_MIME,
      { ...DEFAULT_TEXT_LIMITS, timeoutMs: 10 },
      undefined,
      () => (now += 6),
    );
    expect(slow).toMatchObject({ status: 'failed', code: 'timeout', extractor: 'docx' });
  });

  it('says plainly what it cannot read: PDF (no parser yet), other types, broken archives', () => {
    expect(textMimeTypes()).toContain(PDF_MIME);
    expect(extractText(utf8('%PDF-1.7'), PDF_MIME)).toMatchObject({
      status: 'unsupported',
      code: 'pdf_extractor_missing',
    });
    expect(extractText(utf8('x'), 'image/png')).toMatchObject({
      status: 'unsupported',
      code: 'unsupported_type',
    });
    expect(extractText(utf8('not a zip'), DOCX_MIME)).toMatchObject({
      status: 'failed',
      code: 'zip_unreadable',
    });
  });
});
