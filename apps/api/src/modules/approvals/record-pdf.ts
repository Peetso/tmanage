import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * 52-19 / 52-26 — a small, dependency-free PDF 1.7 writer for the sealed record documents (the
 * approval certificate and the signed-document page). The repository has no PDF writer (only
 * `pdfjs-dist`, a reader, in apps/web), and a new dependency needs an install this slice may not
 * run, so this file writes the few PDF objects a text-and-image A4 page needs, and nothing else.
 *
 * - Text uses the standard Helvetica, Helvetica-Bold and Courier fonts in WinAnsi encoding. A
 *   character outside WinAnsi (Arabic, CJK) prints as `?`; {@link renderRecordPdf} then adds a
 *   note, and the exact sealed text always travels inside the PDF as an attached `.json` file
 *   whose SHA-256 is the record hash printed on the page.
 * - Page content streams are left uncompressed and written as 7-bit ASCII (octal escapes), so the
 *   printed hashes are plain bytes of the file. Images and attachments are Flate-compressed.
 * - The output is deterministic: no creation date, and the file id is a hash of the content, so
 *   the same sealed records always give the same bytes (the store keys the file by content).
 */

export interface PdfRow {
  readonly label: string;
  readonly value: string;
  /** Courier — for hashes and ids, which must be read character by character. */
  readonly mono?: boolean;
}

/** 8-bit RGB pixels, row-major, and an optional 8-bit alpha plane of the same size. */
export interface PdfImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: Buffer;
  readonly alpha: Buffer | null;
}

export interface PdfSection {
  readonly heading: string;
  readonly rows: readonly PdfRow[];
  /** Drawn under the rows (the signer's drawn mark). */
  readonly image?: PdfImage;
}

export interface PdfAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly description: string;
  readonly bytes: Buffer;
}

export interface PdfDocument {
  readonly title: string;
  readonly subtitle: string;
  readonly sections: readonly PdfSection[];
  readonly notes: readonly string[];
  readonly footer: string;
  /** Written into the document information as the subject (searchable in any reader). */
  readonly subject: string;
  readonly attachments: readonly PdfAttachment[];
}

/** Bump when the layout changes, so stored files keyed by {@link recordPdfObjectId} are redone. */
export const RECORD_PDF_LAYOUT = 'record-pdf.v1';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const LABEL_W = 140;
const VALUE_X = MARGIN + LABEL_W;
const VALUE_W = PAGE_W - MARGIN - VALUE_X;
const BODY = 9;
const LEADING = 12.5;
const IMAGE_MAX_W = 220;
const IMAGE_MAX_H = 90;
/** Helvetica's widest common glyphs average under this share of the size; Courier is exact. */
const SANS_EM = 0.56;
const MONO_EM = 0.6;
const LOSSY_NOTE =
  'Some characters cannot be shown in this PDF. The attached record files hold the exact text.';

// prettier-ignore
const CP1252: Readonly<Record<number, number>> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

type Font = 'F1' | 'F2' | 'F3';

/** A UUID-shaped id (version 5 layout) from the layout version and the sealed parts it shows. */
export function recordPdfObjectId(parts: readonly string[]): string {
  const h = createHash('sha256')
    .update([RECORD_PDF_LAYOUT, ...parts].join('\n'), 'utf8')
    .digest('hex');
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Text → WinAnsi bytes as a JS latin-1 string; reports whether a character was replaced. */
function winAnsi(text: string): { readonly bytes: string; readonly lossy: boolean } {
  let bytes = '';
  let lossy = false;
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code < 0x20 || code === 0x7f) bytes += ' ';
    else if (code < 0x7f || (code >= 0xa0 && code <= 0xff)) bytes += String.fromCharCode(code);
    else if (CP1252[code] !== undefined) bytes += String.fromCharCode(CP1252[code]);
    else {
      bytes += '?';
      lossy = true;
    }
  }
  return { bytes, lossy };
}

/** A PDF literal string, 7-bit: `\`, `(`, `)` escaped and every other byte outside ASCII as octal. */
function literal(bytes: string): string {
  let out = '(';
  for (const char of bytes) {
    const code = char.charCodeAt(0);
    if (char === '\\' || char === '(' || char === ')') out += `\\${char}`;
    else if (code < 0x20 || code > 0x7e) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `${out})`;
}

/** Greedy word wrap by an estimated glyph width; a word longer than a line is cut. */
function wrap(text: string, width: number, size: number, mono: boolean): string[] {
  const max = Math.max(8, Math.floor(width / (size * (mono ? MONO_EM : SANS_EM))));
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = word;
      while (rest.length > max) {
        if (line !== '') lines.push(line);
        lines.push(rest.slice(0, max));
        line = '';
        rest = rest.slice(max);
      }
      const next = line === '' ? rest : `${line} ${rest}`;
      if (next.length > max) {
        lines.push(line);
        line = rest;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

function num(value: number): string {
  return Number(value.toFixed(2)).toString();
}

/** Lays the document out on A4 pages and collects the content streams and image uses. */
class Layout {
  readonly pages: string[][] = [[]];
  lossy = false;
  private y = PAGE_H - MARGIN;
  readonly images: PdfImage[] = [];

  private get ops(): string[] {
    return this.pages[this.pages.length - 1] as string[];
  }

  private room(height: number): void {
    if (this.y - height < MARGIN + 24) {
      this.pages.push([]);
      this.y = PAGE_H - MARGIN;
    }
  }

  text(x: number, font: Font, size: number, value: string): void {
    const encoded = winAnsi(value);
    if (encoded.lossy) this.lossy = true;
    this.ops.push(
      `BT /${font} ${num(size)} Tf ${num(x)} ${num(this.y)} Td ${literal(encoded.bytes)} Tj ET`,
    );
  }

  block(font: Font, size: number, value: string, gapAfter: number): void {
    for (const line of wrap(value, PAGE_W - 2 * MARGIN, size, font === 'F3')) {
      this.room(size * 1.4);
      this.y -= size * 1.4;
      this.text(MARGIN, font, size, line);
    }
    this.y -= gapAfter;
  }

  gap(points: number): void {
    this.y -= points;
  }

  rule(): void {
    this.room(10);
    this.y -= 6;
    this.ops.push(
      `0.75 G 0.6 w ${num(MARGIN)} ${num(this.y)} m ${num(PAGE_W - MARGIN)} ${num(this.y)} l S`,
    );
    this.y -= 4;
  }

  row(row: PdfRow): void {
    const mono = row.mono === true;
    const size = mono ? BODY - 0.5 : BODY;
    const values = wrap(row.value === '' ? '-' : row.value, VALUE_W, size, mono);
    const labels = wrap(row.label, LABEL_W - 10, BODY, false);
    const lines = Math.max(values.length, labels.length);
    this.room(lines * LEADING);
    for (let i = 0; i < lines; i += 1) {
      this.y -= LEADING;
      const label = labels[i];
      const value = values[i];
      if (label !== undefined) this.text(MARGIN, 'F2', BODY, label);
      if (value !== undefined) this.text(VALUE_X, mono ? 'F3' : 'F1', size, value);
    }
  }

  image(image: PdfImage): void {
    const scale = Math.min(IMAGE_MAX_W / image.width, IMAGE_MAX_H / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    this.room(h + 8);
    this.y -= h + 8;
    this.images.push(image);
    this.ops.push(
      `q ${num(w)} 0 0 ${num(h)} ${num(VALUE_X)} ${num(this.y)} cm /Im${this.images.length} Do Q`,
    );
  }

  section(section: PdfSection): void {
    this.room(LEADING * 4);
    this.y -= 10;
    this.block('F2', 11.5, section.heading, 0);
    this.rule();
    for (const row of section.rows) this.row(row);
    if (section.image !== undefined) this.image(section.image);
    this.y -= 6;
  }
}

/** Collects numbered objects and writes the file with its cross-reference table. */
class Objects {
  private readonly bodies: Buffer[] = [];

  reserve(): number {
    this.bodies.push(Buffer.alloc(0));
    return this.bodies.length;
  }

  set(id: number, body: string | Buffer): void {
    this.bodies[id - 1] = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
  }

  add(body: string | Buffer): number {
    const id = this.reserve();
    this.set(id, body);
    return id;
  }

  stream(dictionary: string, data: Buffer): Buffer {
    return Buffer.concat([
      Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  }

  write(rootId: number, infoId: number): Buffer {
    const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = parts[0]?.length ?? 0;
    const offsets: number[] = [];
    this.bodies.forEach((body, index) => {
      offsets.push(offset);
      const chunk = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
        body,
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      parts.push(chunk);
      offset += chunk.length;
    });
    const fileId = createHash('md5').update(Buffer.concat(parts)).digest('hex');
    const xref = [
      'xref',
      `0 ${this.bodies.length + 1}`,
      '0000000000 65535 f ',
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
      'trailer',
      `<< /Size ${this.bodies.length + 1} /Root ${rootId} 0 R /Info ${infoId} 0 R ` +
        `/ID [<${fileId}> <${fileId}>] >>`,
      'startxref',
      String(offset),
      '%%EOF',
      '',
    ].join('\n');
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}

function pdfText(value: string): string {
  return literal(winAnsi(value).bytes);
}

/** A PDF name: every byte outside the regular characters as `#xx`. */
function pdfName(value: string): string {
  return `/${Array.from(Buffer.from(value, 'utf8'))
    .map((b) =>
      (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
        ? String.fromCharCode(b)
        : `#${b.toString(16).padStart(2, '0')}`,
    )
    .join('')}`;
}

/** Render the document: A4 pages, a footer with page numbers, images and attached files. */
export function renderRecordPdf(document: PdfDocument): Buffer {
  const layout = new Layout();
  layout.block('F2', 18, document.title, 2);
  layout.block('F1', 10, document.subtitle, 4);
  for (const section of document.sections) layout.section(section);
  layout.gap(8);
  for (const note of [...document.notes, ...(layout.lossy ? [LOSSY_NOTE] : [])]) {
    layout.block('F1', 8.5, note, 3);
  }

  const objects = new Objects();
  const catalogId = objects.reserve();
  const pagesId = objects.reserve();
  // prettier-ignore
  const fonts = {
    F1: objects.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    F2: objects.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'),
    F3: objects.add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'),
  };
  const infoId = objects.add(
    `<< /Title ${pdfText(document.title)} /Subject ${pdfText(document.subject)} ` +
      `/Producer (TManage) /Creator (TManage) >>`,
  );

  const imageIds = layout.images.map((image) => {
    const mask =
      image.alpha === null
        ? ''
        : ` /SMask ${objects.add(
            objects.stream(
              `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
                '/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode',
              deflateSync(image.alpha),
            ),
          )} 0 R`;
    return objects.add(
      objects.stream(
        `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${mask}`,
        deflateSync(image.rgb),
      ),
    );
  });

  const files = [...document.attachments]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((file) => {
      const embedded = objects.add(
        objects.stream(
          `/Type /EmbeddedFile /Subtype ${pdfName(file.mimeType)} /Filter /FlateDecode ` +
            `/Params << /Size ${file.bytes.length} >>`,
          deflateSync(file.bytes),
        ),
      );
      const spec = objects.add(
        `<< /Type /Filespec /F ${pdfText(file.name)} /UF ${pdfText(file.name)} ` +
          `/Desc ${pdfText(file.description)} /AFRelationship /Data /EF << /F ${embedded} 0 R >> >>`,
      );
      return { name: file.name, spec };
    });

  const resources =
    `<< /Font << /F1 ${fonts.F1} 0 R /F2 ${fonts.F2} 0 R /F3 ${fonts.F3} 0 R >>` +
    (imageIds.length === 0
      ? ''
      : ` /XObject << ${imageIds.map((id, i) => `/Im${i + 1} ${id} 0 R`).join(' ')} >>`) +
    ' >>';
  const total = layout.pages.length;
  const pageIds = layout.pages.map((ops, index) => {
    const footer = [
      `BT /F1 7.5 Tf ${num(MARGIN)} ${num(MARGIN - 8)} Td ${pdfText(document.footer)} Tj ET`,
      `BT /F1 7.5 Tf ${num(PAGE_W - MARGIN - 60)} ${num(MARGIN - 8)} Td ` +
        `${pdfText(`Page ${index + 1} of ${total}`)} Tj ET`,
    ];
    const content = objects.add(
      objects.stream('', Buffer.from([...ops, ...footer].join('\n'), 'latin1')),
    );
    return objects.add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] ` +
        `/Resources ${resources} /Contents ${content} 0 R >>`,
    );
  });
  objects.set(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${total} >>`,
  );
  const names =
    files.length === 0
      ? ''
      : ` /Names << /EmbeddedFiles << /Names [${files
          .map((f) => `${pdfText(f.name)} ${f.spec} 0 R`)
          .join(' ')}] >> >> /AF [${files.map((f) => `${f.spec} 0 R`).join(' ')}]` +
        ' /PageMode /UseAttachments';
  objects.set(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R${names} >>`);
  return objects.write(catalogId, infoId);
}
