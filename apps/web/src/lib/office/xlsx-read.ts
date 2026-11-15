import { all, attr, child, openPackage, readXml, relationshipId, relationships } from './ooxml';

/**
 * R4 slice 10 — an Excel workbook as a plain grid of display text, read in the browser.
 *
 * Values only: formulas show their last saved result (Excel stores it), numbers are formatted with
 * the common number formats (thousands, decimals, percent, dates), everything else is shown as
 * stored. Merged cells are drawn as one cell (UX-1). Charts, colours and conditional formats are
 * not drawn — the stage says the
 * layout is approximate. Comments anchor to a cell address (`Rates!C7`), which stays true however
 * the grid is drawn.
 */

export const MAX_ROWS = 500;
export const MAX_COLUMNS = 52;

export interface SheetCell {
  readonly text: string;
  /** Numbers are right-aligned, like Excel. */
  readonly numeric: boolean;
}

export interface SheetGrid {
  readonly name: string;
  readonly hidden: boolean;
  /** Rows and columns drawn (capped at {@link MAX_ROWS} × {@link MAX_COLUMNS}). */
  readonly rowCount: number;
  readonly columnCount: number;
  /** Whether the sheet goes on beyond the cap. */
  readonly truncated: boolean;
  /** `A1` → cell. Only cells with something in them. */
  readonly cells: ReadonlyMap<string, SheetCell>;
  /**
   * UX-1 (live UX test 69836a13): merged ranges, by their top-left address. The other addresses of
   * a range are in {@link covered}: they are not drawn, so a merged header shows once, not in every
   * cell it spans.
   */
  readonly merges: ReadonlyMap<string, { readonly rowSpan: number; readonly colSpan: number }>;
  readonly covered: ReadonlySet<string>;
}

/** The merged ranges of a sheet (`<mergeCell ref="A1:D1"/>`), clipped to the drawn grid. */
export function readMerges(document: Document): {
  readonly merges: Map<string, { readonly rowSpan: number; readonly colSpan: number }>;
  readonly covered: Set<string>;
} {
  const merges = new Map<string, { readonly rowSpan: number; readonly colSpan: number }>();
  const covered = new Set<string>();
  for (const node of all(document, 'mergeCell').slice(0, 5_000)) {
    const [from, to] = (attr(node, 'ref') ?? '').split(':');
    const start = from ? parseCellAddress(from) : null;
    const end = to ? parseCellAddress(to) : null;
    if (!start || !end || start.row >= MAX_ROWS || start.column >= MAX_COLUMNS) continue;
    const lastRow = Math.min(end.row, MAX_ROWS - 1);
    const lastColumn = Math.min(end.column, MAX_COLUMNS - 1);
    if (lastRow < start.row || lastColumn < start.column) continue;
    if (lastRow === start.row && lastColumn === start.column) continue;
    merges.set(`${columnName(start.column)}${start.row + 1}`, {
      rowSpan: lastRow - start.row + 1,
      colSpan: lastColumn - start.column + 1,
    });
    for (let row = start.row; row <= lastRow; row += 1) {
      for (let column = start.column; column <= lastColumn; column += 1) {
        if (row !== start.row || column !== start.column) {
          covered.add(`${columnName(column)}${row + 1}`);
        }
      }
    }
  }
  return { merges, covered };
}

export interface Workbook {
  readonly sheets: readonly SheetGrid[];
}

/** 0 → `A`, 25 → `Z`, 26 → `AA`. */
export function columnName(index: number): string {
  let name = '';
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

/** `C7` → `{ column: 2, row: 6 }` (zero-based); `null` for anything else. */
export function parseCellAddress(address: string): { column: number; row: number } | null {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(address);
  if (!match) return null;
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) - 1 };
}

const BUILT_IN_FORMATS: Readonly<Record<number, string>> = {
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  14: 'yyyy-mm-dd',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  22: 'yyyy-mm-dd hh:mm',
};

/** Excel's serial day (1900 system) as a UTC date. */
function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86_400_000));
}

/** Formats a stored number with the cell's number format, the common cases only. */
export function formatNumber(value: number, format: string | undefined, locale: string): string {
  if (!format || format === 'General') {
    return Number.isInteger(value)
      ? String(value)
      : String(Number.parseFloat(value.toPrecision(12)));
  }
  const pattern = format.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if (/[ymdh]/i.test(pattern) && !/[#0]/.test(pattern)) {
    const date = serialToDate(value);
    const withTime = /h/i.test(pattern);
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
      timeZone: 'UTC',
    }).format(date);
  }
  const decimals = /\.(0+)/.exec(pattern)?.[1]?.length ?? 0;
  const percent = pattern.includes('%');
  const grouping = pattern.includes(',');
  const shown = percent ? value * 100 : value;
  // Digits stay Latin in both languages, as numbers are in the sheet itself.
  const text = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  }).format(shown);
  return percent ? `${text}%` : text;
}

function sharedStrings(document: Document | null): string[] {
  if (!document) return [];
  return all(document, 'si').map((item) =>
    all(item, 't')
      .filter((text) => text.parentElement?.localName !== 'rPh')
      .map((text) => text.textContent ?? '')
      .join(''),
  );
}

function numberFormats(document: Document | null): string[] {
  if (!document) return [];
  const custom = new Map<number, string>();
  for (const format of all(document, 'numFmt')) {
    const id = Number(attr(format, 'numFmtId'));
    const code = attr(format, 'formatCode');
    if (Number.isInteger(id) && code) custom.set(id, code);
  }
  const cellXfs = all(document, 'cellXfs')[0];
  if (!cellXfs) return [];
  return Array.from(cellXfs.children)
    .filter((xf) => xf.localName === 'xf')
    .map((xf) => {
      const id = Number(attr(xf, 'numFmtId') ?? 0);
      return custom.get(id) ?? BUILT_IN_FORMATS[id] ?? 'General';
    });
}

function readSheet(
  name: string,
  hidden: boolean,
  document: Document,
  strings: readonly string[],
  formats: readonly string[],
  locale: string,
): SheetGrid {
  const cells = new Map<string, SheetCell>();
  let rowCount = 0;
  let columnCount = 0;
  let truncated = false;
  for (const cell of all(document, 'c')) {
    const address = attr(cell, 'r');
    const position = address ? parseCellAddress(address) : null;
    if (!address || !position) continue;
    if (position.row >= MAX_ROWS || position.column >= MAX_COLUMNS) {
      truncated = true;
      continue;
    }
    const type = attr(cell, 't');
    const raw = child(cell, 'v')?.textContent ?? null;
    let text = '';
    let numeric = false;
    if (type === 's') text = strings[Number(raw)] ?? '';
    else if (type === 'inlineStr') {
      text = all(cell, 't')
        .map((node) => node.textContent ?? '')
        .join('');
    } else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE';
    else if (type === 'str' || type === 'e') text = raw ?? '';
    else if (raw !== null && raw !== '') {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        numeric = true;
        text = formatNumber(value, formats[Number(attr(cell, 's') ?? 0)], locale);
      } else text = raw;
    }
    if (text === '') continue;
    cells.set(address, { text: text.slice(0, 2000), numeric });
    rowCount = Math.max(rowCount, position.row + 1);
    columnCount = Math.max(columnCount, position.column + 1);
  }
  const { merges, covered } = readMerges(document);
  // Some writers repeat a merged range's value in every cell it covers; only the anchor is shown.
  for (const address of covered) cells.delete(address);
  return { name, hidden, rowCount, columnCount, truncated, cells, merges, covered };
}

/** Reads every sheet of a workbook into display text. Throws when the bytes are not a workbook. */
export async function readWorkbook(
  bytes: ArrayBuffer | Uint8Array,
  locale = 'en',
): Promise<Workbook> {
  const zip = await openPackage(bytes);
  const workbook = await readXml(zip, 'xl/workbook.xml');
  if (!workbook) throw new Error('not a workbook');
  const rels = await relationships(zip, 'xl/workbook.xml');
  const strings = sharedStrings(await readXml(zip, 'xl/sharedStrings.xml'));
  const formats = numberFormats(await readXml(zip, 'xl/styles.xml'));
  const sheets: SheetGrid[] = [];
  for (const sheet of all(workbook, 'sheet').slice(0, 200)) {
    const name = attr(sheet, 'name') ?? '';
    const target = rels.get(relationshipId(sheet) ?? '');
    const state = attr(sheet, 'state');
    const document = target ? await readXml(zip, target) : null;
    if (!name || !document) continue;
    sheets.push(
      readSheet(
        name,
        state === 'hidden' || state === 'veryHidden',
        document,
        strings,
        formats,
        locale,
      ),
    );
  }
  return { sheets };
}
