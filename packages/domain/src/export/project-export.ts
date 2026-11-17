import type { WorkItemState } from '../state-machines/work-item.js';
import { toCsv } from './csv.js';

/**
 * 54-29 — the per-project export (`GET …/projects/:projectId/export?format=csv|json`), shared by
 * the API (which writes it) and the web app (which asks for it and names the download).
 *
 * - **Format** is an allow-list: {@link parseProjectExportFormat} answers `null` for anything that
 *   is not exactly `csv` or `json`, and the route refuses that with a 400 before any read.
 * - **CSV** uses ClickUp's task-CSV column names ({@link PROJECT_EXPORT_CSV_COLUMNS}), so the file
 *   goes straight back in through the ClickUp importer: every column is one that importer matches
 *   by default. Cells go through the shared, formula-guarded {@link toCsv} with a BOM (Arabic in
 *   Excel). The state is written as the word the importer's status rule reads back.
 * - **JSON** carries a {@link PROJECT_EXPORT_VERSION} so a later reader can tell shapes apart.
 * - **File name** is built from an ASCII slug of the project name, never from the raw text, so no
 *   quote, slash or control character can reach the `Content-Disposition` header.
 */

export const PROJECT_EXPORT_FORMATS = ['csv', 'json'] as const;
export type ProjectExportFormat = (typeof PROJECT_EXPORT_FORMATS)[number];

/** The JSON document's shape version. */
export const PROJECT_EXPORT_VERSION = 1;

/** The most work items one export carries; past this the API answers 413. */
export const PROJECT_EXPORT_MAX_ITEMS = 5000;

/** The format from an untrusted query value, or `null` when it is not one we write. */
export function parseProjectExportFormat(value: unknown): ProjectExportFormat | null {
  return typeof value === 'string' && (PROJECT_EXPORT_FORMATS as readonly string[]).includes(value)
    ? (value as ProjectExportFormat)
    : null;
}

/** ClickUp task-CSV header names, the order the export writes them. */
export const PROJECT_EXPORT_CSV_COLUMNS = [
  'Task ID',
  'Task Name',
  'Status',
  'Assignees',
  'Start Date',
  'Due Date',
  'Tags',
  'Task Content',
] as const;

/** One work item as exported. Dates are ISO instants; `ownerEmail` is the import's person match. */
export interface ProjectExportItem {
  readonly id: string;
  readonly title: string;
  readonly state: WorkItemState | string;
  readonly ownerEmail: string | null;
  readonly startAt: string | null;
  readonly dueAt: string | null;
  readonly labels: readonly string[];
  readonly description: string | null;
}

export interface ProjectExportDocument {
  readonly kind: 'tmanage.project-export';
  readonly version: typeof PROJECT_EXPORT_VERSION;
  readonly exportedAt: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly items: readonly ProjectExportItem[];
}

/** The status word the importers' name rule (`suggestState`) reads back as the same state. */
const STATUS_WORD: Readonly<Record<string, string>> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  internal_review: 'In review',
  done: 'Done',
  archived: 'Archived',
};

/** The CSV document: header plus one row per item, formula-guarded, BOM-prefixed. */
export function projectExportCsv(items: readonly ProjectExportItem[]): string {
  return toCsv(
    items.map((item) => [
      item.id,
      item.title,
      STATUS_WORD[item.state] ?? item.state,
      item.ownerEmail ?? '',
      item.startAt ?? '',
      item.dueAt ?? '',
      item.labels.join(', '),
      item.description ?? '',
    ]),
    [...PROJECT_EXPORT_CSV_COLUMNS],
    { bom: true },
  );
}

/** An ASCII file-name slug of a project name: `[a-z0-9-]`, at most 60 characters, never empty. */
export function projectExportSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug === '' ? 'project' : slug;
}

/** `<slug>-<YYYY-MM-DD>.<format>`, safe to put between quotes in `Content-Disposition`. */
export function projectExportFileName(
  name: string,
  format: ProjectExportFormat,
  at: Date = new Date(),
): string {
  return `${projectExportSlug(name)}-${at.toISOString().slice(0, 10)}.${format}`;
}
