import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import bidiModule from 'bidi-js';
import {
  AFRelationship,
  PDFDocument,
  PDFName,
  StandardFonts,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setLineWidth,
  setTextRenderingMode,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

/**
 * 52-19 / 52-26 — the PDF writer for the sealed record documents (the approval certificate and
 * the signed-document pages), on `pdf-lib` (MIT) with `@pdf-lib/fontkit` (MIT) for the embedded
 * TrueType font and `bidi-js` (MIT) for the Unicode bidirectional algorithm.
 *
 * - Latin text uses the standard Helvetica, Helvetica-Bold and Courier fonts. A line holding a
 *   character outside WinAnsi (Arabic, most of all) is set in Alexandria (SIL OFL 1.1, the web
 *   app's own Arabic face; `apps/api/assets/fonts/`), embedded as a subset. fontkit shapes it
 *   (initial / medial / final forms, ligatures) and lays a right-to-left run out right to left;
 *   bidi-js orders the runs of a mixed line (an Arabic name beside Latin digits). A line whose
 *   paragraph direction is right-to-left is right-aligned in its column. Bold Arabic is the
 *   regular face filled and thinly stroked (the bundled face is variable; a PDF draws its
 *   default, 400, instance).
 * - A character neither font draws (CJK) prints as `?`; the page then says so, and the exact
 *   sealed text always travels inside the PDF as an attached `.json` file whose SHA-256 is the
 *   record hash printed on the page.
 * - The output is deterministic: no dates, fixed font names, so the same sealed records (and the
 *   same original document) give the same bytes. The store keys the file by content anyway.
 * - 52-26: {@link renderRecordPdf} can put the original document's pages first — the signed copy
 *   is then the document itself followed by its signature pages.
 */

export interface PdfRow {
  readonly label: string;
  readonly value: string;
  /** Courier — for hashes and ids, which must be read character by character. */
  readonly mono?: boolean;
}

/** A PNG the service already decoded once (so it is known to be a PNG), and its size. */
export interface PdfImage {
  readonly width: number;
  readonly height: number;
  readonly png: Buffer;
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

export interface RenderOptions {
  /** 52-26: a PDF whose pages come first (the signed document). */
  readonly original?: Uint8Array;
}

export interface RenderedPdf {
  readonly bytes: Buffer;
  /** Pages of the original put first; `null` when none was given or it could not be read. */
  readonly originalPages: number | null;
}

/** Bump when the layout changes, so stored files keyed by {@link recordPdfObjectId} are redone. */
export const RECORD_PDF_LAYOUT = 'record-pdf.v2';

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
const LOSSY_NOTE =
  'Some characters cannot be shown in this PDF. The attached record files hold the exact text.';
const MERGED_NOTE = (pages: number) =>
  `Pages 1 to ${String(pages)} are the signed document itself; the pages after them are its ` +
  'signature record.';
const UNREADABLE_NOTE =
  'The original document could not be added to this copy; it is bound by the SHA-256 above.';

// prettier-ignore
const CP1252 = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

const STRONG_RTL = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
// bidi-js is CommonJS whose `module.exports` is the factory; its types declare an ES default.
const bidiFactory = bidiModule as unknown as (typeof bidiModule)['default'];
const bidi = bidiFactory();

/** The bundled Arabic face, read once: next to this file's build (src or dist), else the cwd. */
let arabicFontBytes: Uint8Array | null | undefined;
function arabicFont(): Uint8Array | null {
  if (arabicFontBytes !== undefined) return arabicFontBytes;
  const name = 'Alexandria-Variable.ttf';
  const here = dirname(fileURLToPath(import.meta.url));
  const found = [
    resolve(here, '../../../assets/fonts', name),
    resolve(process.cwd(), 'assets/fonts', name),
  ].find((path) => existsSync(path));
  arabicFontBytes = found === undefined ? null : new Uint8Array(readFileSync(found));
  if (found === undefined) console.warn('[record-pdf] Arabic font missing; Arabic prints as ?');
  return arabicFontBytes;
}

/** A UUID-shaped id (version 5 layout) from the layout version and the sealed parts it shows. */
export function recordPdfObjectId(parts: readonly string[]): string {
  const h = createHash('sha256')
    .update([RECORD_PDF_LAYOUT, ...parts].join('\n'), 'utf8')
    .digest('hex');
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function isWinAnsi(code: number): boolean {
  return (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || CP1252.has(code);
}

type Style = 'regular' | 'bold' | 'mono';

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
  /** `null` when the bundled face is missing. */
  readonly arabic: PDFFont | null;
  readonly covers: (code: number) => boolean;
}

/** One visual run of a line: its text in drawing order input, and whether it reads right to left. */
export interface TextRun {
  readonly text: string;
  readonly rtl: boolean;
}

/** A line ready to draw: the font it is set in, its visual runs and the paragraph direction. */
export interface SetLine {
  readonly font: 'standard' | 'arabic';
  readonly runs: readonly TextRun[];
  readonly rtl: boolean;
  readonly lossy: boolean;
}

/**
 * The Unicode bidirectional algorithm (rules L1–L2) over one line, by runs: the runs come back
 * in visual order, each still in logical order inside (fontkit lays an Arabic run out right to
 * left itself). A right-to-left run with no Arabic letter (punctuation between two Arabic words)
 * is reversed here, and mirrored characters are swapped in every right-to-left run.
 */
export function visualRuns(text: string): { readonly runs: TextRun[]; readonly rtl: boolean } {
  if (text === '') return { runs: [], rtl: false };
  const { levels, paragraphs } = bidi.getEmbeddingLevels(text);
  const base = paragraphs[0]?.level ?? 0;
  const mirrored = bidi.getMirroredCharactersMap(text, levels);
  const units: { readonly text: string; readonly level: number }[] = [];
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i) ?? 0x3f;
    const size = code > 0xffff ? 2 : 1;
    units.push({ text: mirrored.get(i) ?? text.slice(i, i + size), level: levels[i] ?? base });
    i += size;
  }
  const runs: { text: string; level: number }[] = [];
  for (const unit of units) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.level === unit.level) last.text += unit.text;
    else runs.push({ text: unit.text, level: unit.level });
  }
  // L2: from the highest level down to the lowest odd one, reverse every sequence at or above it.
  const highest = Math.max(...runs.map((r) => r.level));
  const lowestOdd = Math.min(...runs.map((r) => (r.level % 2 === 1 ? r.level : r.level + 1)));
  for (let level = highest; level >= lowestOdd; level -= 1) {
    for (let i = 0; i < runs.length;) {
      if ((runs[i]?.level ?? 0) < level) {
        i += 1;
        continue;
      }
      let end = i;
      while (end + 1 < runs.length && (runs[end + 1]?.level ?? 0) >= level) end += 1;
      runs.splice(i, end - i + 1, ...runs.slice(i, end + 1).reverse());
      i = end + 1;
    }
  }
  return {
    rtl: base % 2 === 1,
    runs: runs.map((run) => {
      const rtl = run.level % 2 === 1;
      const reversed = rtl && !STRONG_RTL.test(run.text);
      return { text: reversed ? Array.from(run.text).reverse().join('') : run.text, rtl };
    }),
  };
}

/** Pick the font of a line and replace what neither font can draw; `covers` is the Arabic face. */
export function setLine(raw: string, covers: ((code: number) => boolean) | null): SetLine {
  let text = '';
  let lossy = false;
  let standard = true;
  for (const char of raw.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code < 0x20 || code === 0x7f) text += ' ';
    else if (isWinAnsi(code)) text += char;
    else if (covers?.(code) === true) {
      text += char;
      standard = false;
    } else {
      text += '?';
      lossy = true;
    }
  }
  if (standard) return { font: 'standard', runs: [{ text, rtl: false }], rtl: false, lossy };
  return { font: 'arabic', ...visualRuns(text), lossy };
}

/** Lays the document out on A4 pages. */
class Layout {
  lossy = false;
  private page: PDFPage;
  private y = PAGE_H - MARGIN;
  readonly pages: PDFPage[] = [];

  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: Fonts,
  ) {
    this.page = this.newPage();
  }

  private newPage(): PDFPage {
    const page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(page);
    return page;
  }

  private room(height: number): void {
    if (this.y - height < MARGIN + 24) {
      this.page = this.newPage();
      this.y = PAGE_H - MARGIN;
    }
  }

  private fontOf(line: SetLine, style: Style): PDFFont {
    if (line.font === 'arabic' && this.fonts.arabic !== null) return this.fonts.arabic;
    return this.fonts[style];
  }

  width(raw: string, style: Style, size: number): number {
    const line = setLine(raw, this.fonts.covers);
    const font = this.fontOf(line, style);
    return line.runs.reduce((sum, run) => sum + font.widthOfTextAtSize(run.text, size), 0);
  }

  /** Draw one line inside `[x, x + width]`, right-aligned when it reads right to left. */
  text(x: number, width: number, style: Style, size: number, raw: string): void {
    const line = setLine(raw, this.fonts.covers);
    if (line.lossy) this.lossy = true;
    const font = this.fontOf(line, style);
    const total = line.runs.reduce((sum, run) => sum + font.widthOfTextAtSize(run.text, size), 0);
    let cursor = line.rtl ? x + Math.max(0, width - total) : x;
    const fakeBold = style === 'bold' && font === this.fonts.arabic;
    if (fakeBold) {
      this.page.pushOperators(
        pushGraphicsState(),
        setTextRenderingMode(TextRenderingMode.FillAndOutline),
        setLineWidth(size * 0.035),
      );
    }
    for (const run of line.runs) {
      if (run.text !== '') {
        this.page.drawText(run.text, { x: cursor, y: this.y, size, font, color: rgb(0, 0, 0) });
      }
      cursor += font.widthOfTextAtSize(run.text, size);
    }
    if (fakeBold) this.page.pushOperators(popGraphicsState());
  }

  /** Greedy word wrap by measured width; a word longer than a line is cut. */
  wrap(text: string, width: number, style: Style, size: number): string[] {
    const fits = (value: string) => this.width(value, style, size) <= width;
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        let rest = word;
        while (!fits(rest)) {
          let cut = Array.from(rest).length - 1;
          while (cut > 1 && !fits(Array.from(rest).slice(0, cut).join(''))) cut -= 1;
          if (line !== '') lines.push(line);
          lines.push(Array.from(rest).slice(0, cut).join(''));
          line = '';
          rest = Array.from(rest).slice(cut).join('');
        }
        const next = line === '' ? rest : `${line} ${rest}`;
        if (!fits(next)) {
          lines.push(line);
          line = rest;
        } else line = next;
      }
      lines.push(line);
    }
    return lines;
  }

  block(style: Style, size: number, value: string, gapAfter: number): void {
    const width = PAGE_W - 2 * MARGIN;
    for (const line of this.wrap(value, width, style, size)) {
      this.room(size * 1.4);
      this.y -= size * 1.4;
      this.text(MARGIN, width, style, size, line);
    }
    this.y -= gapAfter;
  }

  gap(points: number): void {
    this.y -= points;
  }

  rule(): void {
    this.room(10);
    this.y -= 6;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness: 0.6,
      color: rgb(0.75, 0.75, 0.75),
    });
    this.y -= 4;
  }

  row(row: PdfRow): void {
    const style: Style = row.mono === true ? 'mono' : 'regular';
    const size = style === 'mono' ? BODY - 0.5 : BODY;
    const values = this.wrap(row.value === '' ? '-' : row.value, VALUE_W, style, size);
    const labels = this.wrap(row.label, LABEL_W - 10, 'bold', BODY);
    const lines = Math.max(values.length, labels.length);
    this.room(lines * LEADING);
    for (let i = 0; i < lines; i += 1) {
      this.y -= LEADING;
      const label = labels[i];
      const value = values[i];
      if (label !== undefined) this.text(MARGIN, LABEL_W - 10, 'bold', BODY, label);
      if (value !== undefined) this.text(VALUE_X, VALUE_W, style, size, value);
    }
  }

  async image(image: PdfImage): Promise<void> {
    const scale = Math.min(IMAGE_MAX_W / image.width, IMAGE_MAX_H / image.height, 1);
    const w = image.width * scale;
    const h = image.height * scale;
    this.room(h + 8);
    this.y -= h + 8;
    const embedded = await this.doc.embedPng(image.png);
    this.page.drawImage(embedded, { x: VALUE_X, y: this.y, width: w, height: h });
  }

  async section(section: PdfSection): Promise<void> {
    this.room(LEADING * 4);
    this.y -= 10;
    this.block('bold', 11.5, section.heading, 0);
    this.rule();
    for (const row of section.rows) this.row(row);
    if (section.image !== undefined) await this.image(section.image);
    this.y -= 6;
  }
}

async function embedFonts(doc: PDFDocument): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const bytes = arabicFont();
  const face = bytes === null ? null : fontkit.create(bytes);
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    arabic:
      bytes === null
        ? null
        : await doc.embedFont(bytes, { subset: true, customName: 'TManageAlexandria' }),
    covers: (code) => face?.hasGlyphForCodePoint(code) === true,
  };
}

/** Put the original's pages first; `null` when it is not a PDF this library can read. */
async function prependOriginal(doc: PDFDocument, original: Uint8Array): Promise<number | null> {
  try {
    const source = await PDFDocument.load(original, { updateMetadata: false });
    const pages = await doc.copyPages(source, source.getPageIndices());
    for (const page of pages) doc.addPage(page);
    return pages.length;
  } catch {
    return null;
  }
}

/** Render the document: A4 pages, a footer with page numbers, images and attached files. */
export async function renderRecordPdf(
  document: PdfDocument,
  options: RenderOptions = {},
): Promise<RenderedPdf> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const originalPages =
    options.original === undefined ? null : await prependOriginal(doc, options.original);
  const fonts = await embedFonts(doc);
  const layout = new Layout(doc, fonts);
  layout.block('bold', 18, document.title, 2);
  layout.block('regular', 10, document.subtitle, 4);
  for (const section of document.sections) await layout.section(section);
  layout.gap(8);
  const notes = [
    ...document.notes,
    ...(originalPages !== null ? [MERGED_NOTE(originalPages)] : []),
    ...(options.original !== undefined && originalPages === null ? [UNREADABLE_NOTE] : []),
  ];
  for (const note of notes) layout.block('regular', 8.5, note, 3);
  if (layout.lossy) layout.block('regular', 8.5, LOSSY_NOTE, 3);

  const total = layout.pages.length;
  layout.pages.forEach((page, index) => {
    const size = 7.5;
    page.drawText(setLine(document.footer, null).runs[0]?.text ?? '', {
      x: MARGIN,
      y: MARGIN - 8,
      size,
      font: fonts.regular,
    });
    page.drawText(`Page ${String(index + 1)} of ${String(total)}`, {
      x: PAGE_W - MARGIN - 60,
      y: MARGIN - 8,
      size,
      font: fonts.regular,
    });
  });

  doc.setTitle(document.title);
  doc.setSubject(document.subject);
  doc.setProducer('TManage');
  doc.setCreator('TManage');
  const files = [...document.attachments].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const file of files) {
    await doc.attach(file.bytes, file.name, {
      mimeType: file.mimeType,
      description: file.description,
      afRelationship: AFRelationship.Data,
    });
  }
  if (files.length > 0) doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseAttachments'));
  return { bytes: Buffer.from(await doc.save({ useObjectStreams: false })), originalPages };
}
