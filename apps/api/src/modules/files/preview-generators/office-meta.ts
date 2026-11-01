import { readZipDirectory, readZipText, ZipReadError } from './zip-reader.js';
import type { ZipDirectory } from './zip-reader.js';
import { failed, unsupported } from './types.js';
import type { PreviewGenerator, PreviewOutcome } from './types.js';

/**
 * R4 slice 10 — Word, PowerPoint and Excel facts (`office_meta`, facts only).
 *
 * No Office file is converted on the server: LibreOffice cannot run on Hostinger shared hosting
 * (SPEC R4 §2). The browser draws the file itself, approximately, and says so. This row gives it
 * the numbers that keep comments in place whatever the renderer does:
 * - PowerPoint: the slide size from the file (`ppt/presentation.xml` `<p:sldSz>`, in EMU) and the
 *   slide count. Pins are stored relative to that slide box.
 * - Word: the page size (`<w:pgSz>`, twentieths of a point) and the page count Word saved
 *   (`docProps/app.xml` `<Pages>`), an estimate.
 * - Excel: the sheet names in workbook order, hidden ones marked. Comments anchor to a cell.
 */

const OOXML = 'application/vnd.openxmlformats-officedocument';
const DOCX = `${OOXML}.wordprocessingml.document`;
const PPTX = `${OOXML}.presentationml.presentation`;
const XLSX = `${OOXML}.spreadsheetml.sheet`;

/** Each XML part read here is small; a bigger one is not what it claims to be. */
const MAX_PART_BYTES = 8 * 1024 * 1024;

export interface OfficeSheetFact {
  readonly name: string;
  readonly hidden: boolean;
}

export interface OfficeFacts {
  readonly format: 'docx' | 'pptx' | 'xlsx';
  /** Slides (PowerPoint) or Word's own page count; `null` when the file does not say. */
  readonly pages: number | null;
  /** PowerPoint slide size in EMU (914 400 a inch); Word page size in twips. */
  readonly pageWidth: number | null;
  readonly pageHeight: number | null;
  readonly sheets: readonly OfficeSheetFact[];
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1]! : null;
}

function positive(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

function text(bytes: Uint8Array, directory: ZipDirectory, path: string): string | null {
  return readZipText(bytes, directory, path, MAX_PART_BYTES);
}

function pptxFacts(bytes: Uint8Array, directory: ZipDirectory): OfficeFacts | null {
  const xml = text(bytes, directory, 'ppt/presentation.xml');
  if (xml === null) return null;
  const size = /<p:sldSz\b[^>]*>/.exec(xml)?.[0] ?? '';
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(xml)?.[1] ?? '';
  const slides = (list.match(/<p:sldId\b/g) ?? []).length;
  return {
    format: 'pptx',
    pages: slides > 0 ? slides : null,
    // PowerPoint's default (16:9, 13.333 × 7.5 in) when the size is missing.
    pageWidth: positive(attribute(size, 'cx')) ?? 12_192_000,
    pageHeight: positive(attribute(size, 'cy')) ?? 6_858_000,
    sheets: [],
  };
}

function docxFacts(bytes: Uint8Array, directory: ZipDirectory): OfficeFacts | null {
  const xml = text(bytes, directory, 'word/document.xml');
  if (xml === null) return null;
  const size = /<w:pgSz\b[^>]*>/.exec(xml)?.[0] ?? '';
  const app = text(bytes, directory, 'docProps/app.xml');
  const pages = positive(app ? (/<Pages>(\d+)<\/Pages>/.exec(app)?.[1] ?? null) : null);
  return {
    format: 'docx',
    pages,
    pageWidth: positive(attribute(size, 'w:w')),
    pageHeight: positive(attribute(size, 'w:h')),
    sheets: [],
  };
}

function xlsxFacts(bytes: Uint8Array, directory: ZipDirectory): OfficeFacts | null {
  const xml = text(bytes, directory, 'xl/workbook.xml');
  if (xml === null) return null;
  const sheets = [...xml.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)]
    .slice(0, 200)
    .map((match): OfficeSheetFact | null => {
      const name = attribute(match[0], 'name');
      if (name === null) return null;
      const state = attribute(match[0], 'state');
      return {
        name: decodeXml(name).slice(0, 100),
        hidden: state === 'hidden' || state === 'veryHidden',
      };
    })
    .filter((sheet): sheet is OfficeSheetFact => sheet !== null);
  return { format: 'xlsx', pages: null, pageWidth: null, pageHeight: null, sheets };
}

export function officeFactsFrom(bytes: Uint8Array, mimeType: string): OfficeFacts | null {
  const directory = readZipDirectory(bytes);
  if (mimeType === PPTX) return pptxFacts(bytes, directory);
  if (mimeType === DOCX) return docxFacts(bytes, directory);
  if (mimeType === XLSX) return xlsxFacts(bytes, directory);
  return null;
}

export const officeMetaGenerator: PreviewGenerator = {
  name: 'office-meta',
  mimeTypes: [DOCX, PPTX, XLSX],
  plan() {
    return [{ kind: 'office_meta' }];
  },
  async generate(source, requests) {
    let facts: OfficeFacts | PreviewOutcome;
    try {
      facts = officeFactsFrom(source.bytes, source.mimeType) ?? failed('office_unreadable');
    } catch (error) {
      facts =
        error instanceof ZipReadError && error.code === 'zip_bomb'
          ? unsupported('unsupported_zip_bomb')
          : failed('office_unreadable');
    }
    return requests.map((request): PreviewOutcome => {
      if (request.kind !== 'office_meta') return unsupported('kind_not_office');
      if ('status' in facts) return facts;
      return {
        status: 'ready',
        body: null,
        mimeType: null,
        width: null,
        height: null,
        // `pages` doubles as the manifest's page count; `approximate` makes the screen say so.
        meta: { ...facts, approximate: true },
      };
    });
  },
};
