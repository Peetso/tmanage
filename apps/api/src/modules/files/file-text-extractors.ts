import { readZipDirectory, readZipText, ZipReadError } from './preview-generators/zip-reader.js';
import type { ZipDirectory } from './preview-generators/zip-reader.js';

/**
 * 62-23 (plan 62 §4.5) — plain text out of a workspace file, for the AI knowledge layer.
 *
 * Pure JavaScript plus Node's own zlib (through the preview job's ZIP reader), so it runs in the
 * one Hostinger Node process; no converter, no model, nothing leaves the server (IP-3: a pure
 * rule, the job is the adapter). One extractor per family:
 *
 * - **plain** — text, Markdown, CSV/TSV, JSON, HTML (tags, scripts and styles removed);
 * - **docx** — `word/document.xml`: paragraphs, tabs, line and page breaks;
 * - **pptx** — each slide's text (`ppt/slides/slideN.xml`), one block per slide;
 * - **xlsx** — each sheet's cells (shared, inline and literal values), one row per line.
 * - **pdf** — the text layer of each page through `unpdf` (MIT, loaded on first use); a PDF with no text layer (a scan) is `unsupported` `pdf_no_text_layer`, said plainly,
 *   for the separate "read with AI" path.
 *
 * **Caps** (plan §4.5: 20 MB, 200 pages, 60 s; ST-1), each one a plain outcome, never a crash:
 * - input over `maxInputBytes` is `unsupported_too_large` and is not parsed;
 * - pages (Word page breaks, slides, sheets) past `maxPages` are cut, `truncated: true`;
 * - text past `maxChars` is cut, `truncated: true`;
 * - the work checks a deadline between parts and rows; past it the outcome is `failed` `timeout`.
 */

export interface TextLimits {
  readonly maxInputBytes: number;
  readonly maxPages: number;
  readonly maxChars: number;
  readonly timeoutMs: number;
}

export const DEFAULT_TEXT_LIMITS: TextLimits = {
  maxInputBytes: 20 * 1024 * 1024,
  maxPages: 200,
  maxChars: 1_000_000,
  timeoutMs: 60_000,
};

export type TextOutcome =
  | {
      readonly status: 'ready';
      readonly text: string;
      readonly pages: number | null;
      readonly truncated: boolean;
    }
  | { readonly status: 'unsupported'; readonly code: string }
  | { readonly status: 'failed'; readonly code: string };

export interface TextExtractor {
  readonly name: string;
  readonly mimeTypes: readonly string[];
  extract(
    bytes: Uint8Array,
    mimeType: string,
    limits: TextLimits,
    deadline: Deadline,
  ): TextOutcome | Promise<TextOutcome>;
}

/** Thrown by {@link Deadline.check} once the time is up; the outcome is `failed` `timeout`. */
export class TextTimeoutError extends Error {
  constructor() {
    super('text extraction timed out');
    this.name = 'TextTimeoutError';
  }
}

export class Deadline {
  private readonly at: number;

  constructor(
    timeoutMs: number,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.at = clock() + timeoutMs;
  }

  check(): void {
    if (this.clock() > this.at) throw new TextTimeoutError();
  }

  /** Milliseconds left, at least 0: the bound for one awaited step (a PDF page). */
  remainingMs(): number {
    return Math.max(0, this.at - this.clock());
  }
}

const OOXML = 'application/vnd.openxmlformats-officedocument';
export const DOCX_MIME = `${OOXML}.wordprocessingml.document`;
export const PPTX_MIME = `${OOXML}.presentationml.presentation`;
export const XLSX_MIME = `${OOXML}.spreadsheetml.sheet`;
export const PDF_MIME = 'application/pdf';

/** One XML part may inflate to at most this; a bigger one is refused, not read. */
const MAX_PART_BYTES = 64 * 1024 * 1024;

/** Collects text up to the character cap (code points); `full` once it is reached. */
class TextBuffer {
  private readonly parts: string[] = [];
  private length = 0;
  truncated = false;

  constructor(private readonly maxChars: number) {}

  get full(): boolean {
    return this.length >= this.maxChars;
  }

  push(text: string): void {
    if (text === '') return;
    if (this.full) {
      this.truncated = true;
      return;
    }
    const points = [...text];
    const room = this.maxChars - this.length;
    const piece = points.length > room ? points.slice(0, room) : points;
    if (piece.length < points.length) this.truncated = true;
    this.parts.push(piece.join(''));
    this.length += piece.length;
  }

  toString(): string {
    return tidy(this.parts.join(''));
  }
}

/** Line ends to `\n`, no trailing spaces, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fromCode(code: number, whole: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : whole;
}

export function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (whole, code: string) => fromCode(Number(code), whole))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code: string) => fromCode(parseInt(code, 16), whole))
    .replace(/&amp;/g, '&');
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
const NUL = String.fromCodePoint(0);

// ---- plain ----------------------------------------------------------------------------------

const PLAIN_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'text/html',
] as const;

function htmlText(html: string): string {
  return decodeXmlText(
    html
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' '),
  ).replace(/[ \t]{2,}/g, ' ');
}

export const plainTextExtractor: TextExtractor = {
  name: 'plain',
  mimeTypes: PLAIN_TYPES,
  extract(bytes, mimeType, limits, deadline) {
    deadline.check();
    const raw = utf8.decode(bytes);
    // A text file holds no NUL; one that does is binary under a text label.
    if (raw.includes(NUL)) return { status: 'failed', code: 'not_text' };
    const buffer = new TextBuffer(limits.maxChars);
    buffer.push(mimeType === 'text/html' ? htmlText(raw) : raw);
    return { status: 'ready', text: buffer.toString(), pages: null, truncated: buffer.truncated };
  },
};

// ---- Office (ZIP + XML) ---------------------------------------------------------------------

function part(bytes: Uint8Array, directory: ZipDirectory, path: string): string | null {
  return readZipText(bytes, directory, path, MAX_PART_BYTES);
}

const WORD_RUNS = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>|<w:tab\s*\/>|<w:br\b[^>]*\/>/g;
const DRAWING_RUNS = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<\/a:p>|<a:br\b[^>]*\/>/g;

/** The text runs of a WordprocessingML or DrawingML part, paragraph by paragraph. */
function runs(xml: string, pattern: RegExp): string {
  let out = '';
  for (const match of xml.matchAll(pattern)) {
    const [whole, text] = match;
    if (text !== undefined) out += decodeXmlText(text);
    else if (whole.startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out;
}

const PAGE_BREAK = /<w:br\b[^>]*w:type="page"[^>]*\/>|<w:lastRenderedPageBreak\s*\/>/;

function docx(bytes: Uint8Array, limits: TextLimits, deadline: Deadline): TextOutcome {
  const directory = readZipDirectory(bytes);
  const xml = part(bytes, directory, 'word/document.xml');
  if (xml === null) return { status: 'failed', code: 'docx_body_missing' };
  deadline.check();
  const buffer = new TextBuffer(limits.maxChars);
  // A page ends at an explicit page break or where Word last laid one out.
  const pages = xml.split(PAGE_BREAK);
  const kept = pages.slice(0, limits.maxPages);
  for (const page of kept) {
    deadline.check();
    buffer.push(runs(page, WORD_RUNS));
    if (buffer.full) break;
    buffer.push('\n');
  }
  return {
    status: 'ready',
    text: buffer.toString(),
    pages: pages.length,
    truncated: buffer.truncated || pages.length > kept.length,
  };
}

function numbered(directory: ZipDirectory, pattern: RegExp): string[] {
  return directory.entries
    .flatMap((entry) => {
      const match = pattern.exec(entry.path);
      return match ? [{ path: entry.path, no: Number(match[1]) }] : [];
    })
    .sort((a, b) => a.no - b.no)
    .map((entry) => entry.path);
}

function pptx(bytes: Uint8Array, limits: TextLimits, deadline: Deadline): TextOutcome {
  const directory = readZipDirectory(bytes);
  const slides = numbered(directory, /^ppt\/slides\/slide(\d+)\.xml$/);
  if (slides.length === 0) return { status: 'failed', code: 'pptx_slides_missing' };
  const buffer = new TextBuffer(limits.maxChars);
  const kept = slides.slice(0, limits.maxPages);
  for (const [index, path] of kept.entries()) {
    if (buffer.full) break;
    deadline.check();
    const xml = part(bytes, directory, path) ?? '';
    buffer.push(`Slide ${String(index + 1)}\n${runs(xml, DRAWING_RUNS)}\n`);
  }
  return {
    status: 'ready',
    text: buffer.toString(),
    pages: slides.length,
    truncated: buffer.truncated || slides.length > kept.length,
  };
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decodeXmlText(match[1]!) : null;
}

const TEXT_RUN = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;

function joinedRuns(xml: string): string {
  return [...xml.matchAll(TEXT_RUN)].map((t) => decodeXmlText(t[1]!)).join('');
}

function sharedStrings(bytes: Uint8Array, directory: ZipDirectory): string[] {
  const xml = part(bytes, directory, 'xl/sharedStrings.xml');
  if (xml === null) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => joinedRuns(match[1]!));
}

/** Sheet names and parts in workbook order (through its relationships), else by number. */
function sheets(bytes: Uint8Array, directory: ZipDirectory): { name: string; path: string }[] {
  const workbook = part(bytes, directory, 'xl/workbook.xml') ?? '';
  const rels = part(bytes, directory, 'xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (id === null || target === null) continue;
    targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const listed = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].flatMap((match) => {
    const name = attribute(match[0], 'name');
    const id = attribute(match[0], 'r:id');
    const path = id === null ? undefined : targets.get(id);
    return name === null || path === undefined ? [] : [{ name, path }];
  });
  if (listed.length > 0) return listed;
  return numbered(directory, /^xl\/worksheets\/sheet(\d+)\.xml$/).map((path, index) => ({
    name: `Sheet ${String(index + 1)}`,
    path,
  }));
}

function cellText(attributes: string, body: string, strings: readonly string[]): string {
  const type = attribute(attributes, 't');
  if (type === 'inlineStr') return joinedRuns(body);
  const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (value === undefined) return '';
  if (type === 's') return strings[Number(value)] ?? '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return decodeXmlText(value);
}

const ROW = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function xlsx(bytes: Uint8Array, limits: TextLimits, deadline: Deadline): TextOutcome {
  const directory = readZipDirectory(bytes);
  const list = sheets(bytes, directory);
  if (list.length === 0) return { status: 'failed', code: 'xlsx_sheets_missing' };
  const strings = sharedStrings(bytes, directory);
  const buffer = new TextBuffer(limits.maxChars);
  const kept = list.slice(0, limits.maxPages);
  for (const sheet of kept) {
    if (buffer.full) break;
    deadline.check();
    const xml = part(bytes, directory, sheet.path) ?? '';
    buffer.push(`Sheet: ${sheet.name}\n`);
    let rowNo = 0;
    for (const row of xml.matchAll(ROW)) {
      rowNo += 1;
      if (rowNo % 500 === 0) deadline.check();
      const cells = [...row[1]!.matchAll(CELL)].map((cell) =>
        cellText(cell[1] ?? '', cell[2] ?? '', strings),
      );
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line !== '') buffer.push(`${line}\n`);
      if (buffer.full) break;
    }
    buffer.push('\n');
  }
  return {
    status: 'ready',
    text: buffer.toString(),
    pages: list.length,
    truncated: buffer.truncated || list.length > kept.length,
  };
}

function zipped(
  name: string,
  mimeType: string,
  read: (bytes: Uint8Array, limits: TextLimits, deadline: Deadline) => TextOutcome,
): TextExtractor {
  return {
    name,
    mimeTypes: [mimeType],
    extract(bytes, _mimeType, limits, deadline) {
      try {
        return read(bytes, limits, deadline);
      } catch (error) {
        if (error instanceof ZipReadError) return { status: 'failed', code: error.code };
        throw error;
      }
    },
  };
}

export const docxExtractor = zipped('docx', DOCX_MIME, docx);
export const pptxExtractor = zipped('pptx', PPTX_MIME, pptx);
export const xlsxExtractor = zipped('xlsx', XLSX_MIME, xlsx);

// ---- PDF (unpdf, PDF.js) ----------------------------------------------------------------------

interface PdfPage {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  cleanup(): unknown;
}

interface PdfDocument {
  readonly numPages: number;
  getPage(pageNo: number): Promise<PdfPage>;
  /** PDF.js frees the document's worker-side memory; absent on some builds. */
  destroy?(): Promise<void>;
  cleanup?(): Promise<void>;
}

/** One awaited step, bounded by what is left of the deadline (ST-1: a stuck page cannot hang). */
async function bounded<T>(work: Promise<T>, deadline: Deadline): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TextTimeoutError()), deadline.remainingMs());
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pageText(items: readonly unknown[]): string {
  let out = '';
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { str, hasEOL } = item as { str?: unknown; hasEOL?: unknown };
    if (typeof str === 'string') out += str;
    if (hasEOL === true) out += '\n';
  }
  return out;
}

function pdfFailure(error: unknown): TextOutcome {
  if (error instanceof TextTimeoutError) throw error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'PasswordException') return { status: 'unsupported', code: 'pdf_encrypted' };
  return { status: 'failed', code: 'pdf_unreadable' };
}

export const pdfExtractor: TextExtractor = {
  name: 'pdf',
  mimeTypes: [PDF_MIME],
  async extract(bytes, _mimeType, limits, deadline) {
    deadline.check();
    const { getDocumentProxy } = await import('unpdf');
    let document: PdfDocument;
    try {
      // PDF.js takes ownership of the buffer it is given: hand it a copy.
      document = (await bounded(
        getDocumentProxy(new Uint8Array(bytes)),
        deadline,
      )) as unknown as PdfDocument;
    } catch (error) {
      return pdfFailure(error);
    }
    try {
      const buffer = new TextBuffer(limits.maxChars);
      const pages = document.numPages;
      const kept = Math.min(pages, limits.maxPages);
      for (let pageNo = 1; pageNo <= kept && !buffer.full; pageNo += 1) {
        deadline.check();
        const page = await bounded(document.getPage(pageNo), deadline);
        const content = await bounded(page.getTextContent(), deadline);
        page.cleanup();
        buffer.push(`${pageText(content.items)}\n\n`);
      }
      const text = buffer.toString();
      if (text === '') return { status: 'unsupported', code: 'pdf_no_text_layer' };
      return { status: 'ready', text, pages, truncated: buffer.truncated || pages > kept };
    } catch (error) {
      return pdfFailure(error);
    } finally {
      await (document.destroy ?? document.cleanup)?.call(document).catch(() => undefined);
    }
  },
};

export const TEXT_EXTRACTORS: readonly TextExtractor[] = [
  plainTextExtractor,
  docxExtractor,
  pptxExtractor,
  xlsxExtractor,
  pdfExtractor,
];

/** The types the text job plans rows for. */
export function textMimeTypes(extractors: readonly TextExtractor[] = TEXT_EXTRACTORS): string[] {
  return [...new Set(extractors.flatMap((e) => e.mimeTypes))];
}

export function extractorFor(
  mimeType: string,
  extractors: readonly TextExtractor[] = TEXT_EXTRACTORS,
): TextExtractor | null {
  return extractors.find((e) => e.mimeTypes.includes(mimeType)) ?? null;
}

export type ExtractedText = TextOutcome & { readonly extractor: string | null };

/**
 * One file's text, every cap applied. Never throws for anything the file's bytes cause: a
 * timeout is `failed` `timeout`, an unexpected parse fault `failed` `extract_error`.
 */
export async function extractText(
  bytes: Uint8Array,
  mimeType: string,
  limits: TextLimits = DEFAULT_TEXT_LIMITS,
  extractors: readonly TextExtractor[] = TEXT_EXTRACTORS,
  clock: () => number = () => Date.now(),
): Promise<ExtractedText> {
  if (bytes.byteLength > limits.maxInputBytes) {
    return { status: 'unsupported', code: 'unsupported_too_large', extractor: null };
  }
  const extractor = extractorFor(mimeType, extractors);
  if (extractor === null) {
    return { status: 'unsupported', code: 'unsupported_type', extractor: null };
  }
  try {
    const outcome = await extractor.extract(
      bytes,
      mimeType,
      limits,
      new Deadline(limits.timeoutMs, clock),
    );
    return { ...outcome, extractor: extractor.name };
  } catch (error) {
    const code = error instanceof TextTimeoutError ? 'timeout' : 'extract_error';
    return { status: 'failed', code, extractor: extractor.name };
  }
}
