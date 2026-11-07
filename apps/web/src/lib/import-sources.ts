import type { ImportBatchInput, ImportSourceKind } from './api/imports';

/**
 * R31 (A11) — the import start page's sources and the pure steps between a picked file and the
 * batch `POST …/imports/validations` takes: a CSV reader, the default column match per source,
 * and the batch builder. Trello and Asana have no API kind of their own: their CSV exports are a
 * task table, so they post as `notion_database` with their own column names in the mapping (the
 * API reads `mapping[field]` before its Notion aliases). Basecamp is a ZIP read in the browser
 * (the API has no ZIP reader), one `message` row per HTML page.
 */

export const IMPORT_SOURCE_IDS = ['csv', 'jira', 'notion', 'basecamp', 'trello', 'asana'] as const;
export type ImportSourceId = (typeof IMPORT_SOURCE_IDS)[number];

/** The API's batch bound (`MAX_IMPORT_ROWS`). */
export const MAX_IMPORT_ROWS = 1000;

/** The synthetic column the `csv` source fills with the chosen workspace id. */
export const WORKSPACE_COLUMN = '__workspace';

export interface ImportTargetField {
  /** The API's target field name. */
  readonly target: string;
  readonly required: boolean;
  /** Header names matched case-insensitively, in preference order. */
  readonly aliases: readonly string[];
}

export interface ImportSourcePreset {
  readonly id: ImportSourceId;
  readonly kind: ImportSourceKind;
  /** What the file input accepts. */
  readonly file: 'csv' | 'zip';
  /** Rows land in one chosen project (every kind but `project`). */
  readonly needsProject: boolean;
  readonly fields: readonly ImportTargetField[];
}

const field = (
  target: string,
  aliases: readonly string[],
  required = false,
): ImportTargetField => ({
  target,
  required,
  aliases,
});

export const IMPORT_SOURCES: Readonly<Record<ImportSourceId, ImportSourcePreset>> = {
  csv: {
    id: 'csv',
    kind: 'project',
    file: 'csv',
    needsProject: false,
    fields: [
      field('name', ['Name', 'Project', 'Project name', 'Title'], true),
      field('targetDate', ['Target date', 'Due date', 'Due', 'Deadline']),
    ],
  },
  jira: {
    id: 'jira',
    kind: 'jira_issues',
    file: 'csv',
    needsProject: true,
    fields: [
      field('issueKey', ['Issue key', 'Key'], true),
      field('summary', ['Summary'], true),
      field('issueType', ['Issue Type']),
      field('status', ['Status']),
      field('statusCategory', ['Status Category']),
      field('priority', ['Priority']),
      field('assigneeEmail', ['Assignee']),
      field('sprint', ['Sprint']),
      field('parent', ['Parent', 'Parent id']),
      field('description', ['Description']),
      field('created', ['Created']),
      field('dueDate', ['Due date', 'Due Date']),
    ],
  },
  notion: {
    id: 'notion',
    kind: 'notion_database',
    file: 'csv',
    needsProject: true,
    fields: [
      field('name', ['Name', 'Title', 'Task name'], true),
      field('status', ['Status']),
      field('person', ['Assign', 'Assignee', 'Person', 'Owner']),
      field('date', ['Due', 'Due date', 'Date']),
      field('priority', ['Priority']),
      field('tags', ['Tags']),
      field('description', ['Description', 'Notes']),
    ],
  },
  basecamp: {
    id: 'basecamp',
    kind: 'basecamp_messages',
    file: 'zip',
    needsProject: true,
    fields: [],
  },
  trello: {
    id: 'trello',
    kind: 'notion_database',
    file: 'csv',
    needsProject: true,
    fields: [
      field('name', ['Card Name', 'Name', 'Title'], true),
      field('status', ['List Name', 'List']),
      field('person', ['Members', 'Member']),
      field('date', ['Due Date', 'Due']),
      field('tags', ['Labels']),
      field('description', ['Card Description', 'Description']),
    ],
  },
  asana: {
    id: 'asana',
    kind: 'notion_database',
    file: 'csv',
    needsProject: true,
    fields: [
      field('name', ['Name', 'Task Name'], true),
      field('status', ['Section/Column', 'Section']),
      field('person', ['Assignee Email', 'Assignee']),
      field('date', ['Due Date', 'Due']),
      field('tags', ['Tags']),
      field('description', ['Notes', 'Description']),
    ],
  },
};

export interface ParsedTable {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** True when the file had more rows than {@link MAX_IMPORT_ROWS}; the rest are dropped. */
  readonly truncated: boolean;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a leading BOM. Blank lines skipped. */
export function parseCsv(text: string): ParsedTable {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      record.push(cell);
      records.push(record);
      record = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || record.length > 0) {
    record.push(cell);
    records.push(record);
  }
  const nonEmpty = records.filter((r) => r.some((value) => value.trim() !== ''));
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const body = nonEmpty.slice(1);
  const rows = body.slice(0, MAX_IMPORT_ROWS).map((values) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      // A repeated header (Jira's several `Sprint` columns) keeps its first non-empty value.
      const value = values[index] ?? '';
      if (row[header] === undefined || row[header] === '') row[header] = value;
    });
    return row;
  });
  return { headers, rows, truncated: body.length > MAX_IMPORT_ROWS };
}

/** The default column for each target field: the first alias present among the headers. */
export function autoMap(
  preset: ImportSourcePreset,
  headers: readonly string[],
): Record<string, string> {
  const byLower = new Map(headers.map((h) => [h.toLowerCase(), h] as const));
  const mapping: Record<string, string> = {};
  for (const target of preset.fields) {
    const hit = target.aliases.map((alias) => byLower.get(alias.toLowerCase())).find(Boolean);
    mapping[target.target] = hit ?? '';
  }
  return mapping;
}

/** The required target fields the mapping leaves empty. */
export function missingRequired(
  preset: ImportSourcePreset,
  mapping: Readonly<Record<string, string>>,
): string[] {
  return preset.fields.filter((f) => f.required && !mapping[f.target]).map((f) => f.target);
}

const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T/u;

/**
 * The batch for the API. Empty mapping entries are dropped; the `csv` source gets the chosen
 * workspace in a synthetic column; Trello / Asana date-times (`2026-03-04T12:00:00.000Z`) are cut
 * to the day the Notion date reader accepts.
 */
export function buildBatch(
  preset: ImportSourcePreset,
  rows: readonly Readonly<Record<string, unknown>>[],
  mapping: Readonly<Record<string, string>>,
  workspaceId?: string,
): ImportBatchInput {
  const chosen = Object.fromEntries(Object.entries(mapping).filter(([, column]) => column !== ''));
  if (preset.kind === 'project') {
    return {
      sourceKind: preset.kind,
      mapping: { ...chosen, workspaceId: WORKSPACE_COLUMN },
      rows: rows.map((row) => ({ ...row, [WORKSPACE_COLUMN]: workspaceId ?? '' })),
    };
  }
  const dateColumn = chosen['date'];
  if ((preset.id !== 'trello' && preset.id !== 'asana') || dateColumn === undefined) {
    return { sourceKind: preset.kind, mapping: chosen, rows };
  }
  return {
    sourceKind: preset.kind,
    mapping: chosen,
    rows: rows.map((row) => {
      const value = row[dateColumn];
      const match = typeof value === 'string' ? ISO_DATE_TIME.exec(value) : null;
      return match ? { ...row, [dateColumn]: match[1] } : row;
    }),
  };
}

/** The API's bound on one Basecamp HTML body (`MAX_BASECAMP_HTML`). */
const MAX_BASECAMP_HTML = 256 * 1024;

/**
 * A Basecamp archive (ZIP) as `basecamp_messages` rows: one `message` row per HTML page, titled
 * by its `<title>` or first heading. Pages whose body is over the API bound are left out.
 */
export async function readBasecampArchive(
  bytes: ArrayBuffer,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const parser = new DOMParser();
  const rows: Record<string, unknown>[] = [];
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && /\.html?$/iu.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (rows.length >= MAX_IMPORT_ROWS) break;
    const doc = parser.parseFromString(await entry.async('string'), 'text/html');
    const html = doc.body?.innerHTML ?? '';
    if (html.length > MAX_BASECAMP_HTML) continue;
    const heading = doc.querySelector('h1, h2')?.textContent?.trim();
    const fileName =
      entry.name
        .split('/')
        .pop()
        ?.replace(/\.html?$/iu, '') ?? entry.name;
    const title = (doc.title.trim() || heading || fileName).slice(0, 255);
    rows.push({ kind: 'message', path: entry.name.slice(0, 1024), title, html });
  }
  return rows;
}
