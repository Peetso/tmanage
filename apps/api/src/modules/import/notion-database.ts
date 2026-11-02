/**
 * R22-f (54-28) — the Notion database CSV importer, pure half.
 *
 * Governing source: `54-FEATURE-GAPS-PLATFORM-ECOSYSTEM.md` §10.5 **54-28** ("Notion database CSV
 * export … the v1 mapping UI, now with the v2 preview and undo"). The web client parses the CSV;
 * the API sees JSON rows bounded by `MAX_IMPORT_ROWS`. A Notion export's headers are the
 * database's property names, so every target field has default header aliases
 * ({@link NOTION_FIELDS}) and the caller's `mapping` overrides them per field.
 *
 * What this file decides, without I/O or a clock:
 * - title: required, ≤ 255 characters;
 * - dates: Notion's `March 4, 2026` and ISO forms ({@link parseNotionDate}); a range
 *   `March 4, 2026 → March 9, 2026` becomes `startAt` (start) and `dueAt` (end);
 * - tags: split on `,` and become work labels;
 * - status: by the same category rule as Jira (`Not started` / `To do` / `Backlog` → backlog,
 *   `In progress` / `Doing` → in_progress, `Done` / `Complete` → done), the caller's `statusMap`
 *   (R21-e's option shape) overriding, else `backlog` with the `notion_status_unmapped` note.
 *   `jira-issues.ts`'s `mapStatus` reads Jira's category vocabulary, so the Notion words are a
 *   table of their own here;
 * - person: matched by display name through the caller's resolver (`userMap` first, then a
 *   unique active member); otherwise unassigned and counted (Privacy: no account linking by
 *   guess).
 */

import type { WorkItemState } from '@tmanage/domain';
import type { FieldError, SourceMapping, SourceRow } from './import-validation.js';
import { MAX_LABEL_NAME, isJiraTargetState } from './jira-issues.js';

/** Target field → the Notion property names that carry it by default, in preference order. */
export const NOTION_FIELDS = {
  name: ['Name', 'Title', 'Task name'],
  status: ['Status'],
  person: ['Assign', 'Assignee', 'Person', 'Owner'],
  date: ['Due', 'Due date', 'Date'],
  priority: ['Priority'],
  tags: ['Tags'],
  created: ['Created', 'Created time'],
  description: ['Description', 'Notes'],
  url: ['URL'],
} as const;
export type NotionField = keyof typeof NOTION_FIELDS;

/** The task title bound this importer offers (`work_items.title` is wider). */
export const MAX_NOTION_TITLE = 255;
const MAX_DESCRIPTION = 20_000;
const MAX_TAGS = 20;
const MAX_PERSON = 190;

/** The column carrying `field` for this row: the mapping's choice, else the first alias present. */
function cell(field: NotionField, mapping: SourceMapping, row: SourceRow): unknown {
  const mapped = mapping[field];
  if (mapped !== undefined) return row[mapped];
  for (const alias of NOTION_FIELDS[field]) {
    if (alias in row) return row[alias];
  }
  return undefined;
}

function text(field: NotionField, mapping: SourceMapping, row: SourceRow): string | undefined {
  const value = cell(field, mapping, row);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function isoDate(year: number, month: number, day: number): string | null {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

/** One Notion date (`March 4, 2026`, `Mar 4, 2026 10:00 AM`, `2026-03-04`) as `YYYY-MM-DD`. */
function parseOne(value: string): string | null {
  const text = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/u.exec(text);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})(?:\s.*)?$/u.exec(text);
  if (named) {
    const month = MONTHS[(named[1] ?? '').slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return isoDate(Number(named[3]), month, Number(named[2]));
  }
  return null;
}

export interface NotionDateRange {
  /** Only for a range: its first day. */
  readonly start: string | null;
  /** The single date, or the range's last day. */
  readonly end: string;
}

/**
 * A Notion date cell. `undefined` when empty, `null` when present but not a date (or a range
 * that ends before it starts), else the date or the range (`→`, or `->` from a re-saved CSV).
 */
export function parseNotionDate(value: unknown): NotionDateRange | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  if (value.trim() === '') return undefined;
  const parts = value.split(/\s*(?:→|->)\s*/u);
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const single = parseOne(parts[0] ?? '');
    return single === null ? null : { start: null, end: single };
  }
  const start = parseOne(parts[0] ?? '');
  const end = parseOne(parts[1] ?? '');
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/** Tags as label names: split on `,`, trimmed, de-duplicated, empty dropped. */
export function splitTags(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return [
    ...new Set(
      value
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ''),
    ),
  ];
}

/** Validate one Notion row; field errors name the target field. */
export function validateNotionRow(mapping: SourceMapping, row: SourceRow): readonly FieldError[] {
  const errors: FieldError[] = [];
  const title = text('name', mapping, row);
  if (title === undefined) errors.push({ field: 'name', message: 'must be a non-empty string' });
  else if (title.length > MAX_NOTION_TITLE) {
    errors.push({ field: 'name', message: `must be ${MAX_NOTION_TITLE} characters or fewer` });
  }
  if (parseNotionDate(cell('date', mapping, row)) === null) {
    errors.push({ field: 'date', message: 'must be a date like March 4, 2026 or a range with →' });
  }
  const tags = splitTags(text('tags', mapping, row));
  if (tags.length > MAX_TAGS) {
    errors.push({ field: 'tags', message: `must be ${MAX_TAGS} tags or fewer` });
  }
  if (tags.some((tag) => tag.length > MAX_LABEL_NAME)) {
    errors.push({
      field: 'tags',
      message: `each tag must be ${MAX_LABEL_NAME} characters or fewer`,
    });
  }
  const person = text('person', mapping, row);
  if (person !== undefined && person.length > MAX_PERSON) {
    errors.push({ field: 'person', message: `must be ${MAX_PERSON} characters or fewer` });
  }
  const description = cell('description', mapping, row);
  if (typeof description === 'string' && description.length > MAX_DESCRIPTION) {
    errors.push({
      field: 'description',
      message: `must be ${MAX_DESCRIPTION} characters or fewer`,
    });
  }
  return errors;
}

/** Notion's default status options and their usual renames, as work states. */
const NOTION_STATUS_STATES: Readonly<Record<string, WorkItemState>> = {
  'not started': 'backlog',
  'to do': 'backlog',
  todo: 'backlog',
  backlog: 'backlog',
  'in progress': 'in_progress',
  doing: 'in_progress',
  done: 'done',
  complete: 'done',
  completed: 'done',
};

/** A Notion status as a work state; `unmapped` is true when the default had to be used. */
export function mapNotionStatus(
  status: string | undefined,
  statusMap: Readonly<Record<string, string>> = {},
): { readonly state: WorkItemState; readonly unmapped: boolean } {
  if (status === undefined) return { state: 'backlog', unmapped: false };
  const mapped = statusMap[status];
  if (isJiraTargetState(mapped)) return { state: mapped, unmapped: false };
  const byName = NOTION_STATUS_STATES[status.trim().toLowerCase()];
  if (byName) return { state: byName, unmapped: false };
  return { state: 'backlog', unmapped: true };
}

export interface NotionItemPlan {
  readonly rowIndex: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: WorkItemState;
  /** `YYYY-MM-DD` or null. */
  readonly startOn: string | null;
  readonly dueOn: string | null;
  readonly labels: readonly string[];
  /** The resolved owner, or null (no person, or no unique match). */
  readonly ownerUserId: string | null;
}

export interface NotionCommitPlan {
  readonly items: readonly NotionItemPlan[];
  /** Every distinct tag of the batch, in first-seen order. */
  readonly labels: readonly string[];
  /** `notion_status_unmapped:<names>`, `notion_person_unmatched:<n>`. */
  readonly notes: readonly string[];
}

/**
 * The plan for the **valid** rows of a batch. `resolvePerson` maps a display name to a user id
 * (the commit pre-loads `userMap` and the active members); `null` leaves the item unassigned.
 */
export function notionCommitPlan(
  mapping: SourceMapping,
  rows: readonly { readonly rowIndex: number; readonly row: SourceRow }[],
  options: {
    readonly statusMap?: Readonly<Record<string, string>>;
    readonly resolvePerson: (name: string) => string | null;
  },
): NotionCommitPlan {
  const unmappedStatuses = new Set<string>();
  const labels = new Set<string>();
  let personUnmatched = 0;
  const items = rows.map(({ rowIndex, row }): NotionItemPlan => {
    const status = text('status', mapping, row);
    const mapped = mapNotionStatus(status, options.statusMap);
    if (mapped.unmapped && status !== undefined) unmappedStatuses.add(status);
    const tags = splitTags(text('tags', mapping, row));
    for (const tag of tags) labels.add(tag);
    const person = text('person', mapping, row);
    const ownerUserId = person === undefined ? null : options.resolvePerson(person);
    if (person !== undefined && ownerUserId === null) personUnmatched += 1;
    const dates = parseNotionDate(cell('date', mapping, row)) ?? null;
    return {
      rowIndex,
      title: text('name', mapping, row) ?? '',
      description: describe(mapping, row),
      state: mapped.state,
      startOn: dates?.start ?? null,
      dueOn: dates?.end ?? null,
      labels: tags,
      ownerUserId,
    };
  });
  const notes: string[] = [];
  if (unmappedStatuses.size > 0) {
    notes.push(`notion_status_unmapped:${[...unmappedStatuses].sort().join(', ')}`);
  }
  if (personUnmatched > 0) notes.push(`notion_person_unmatched:${personUnmatched}`);
  return { items, labels: [...labels], notes };
}

/** The description plus the properties with no column of their own (priority, URL). */
function describe(mapping: SourceMapping, row: SourceRow): string | null {
  const lines: string[] = [];
  const body = text('description', mapping, row);
  if (body !== undefined) lines.push(body);
  const priority = text('priority', mapping, row);
  if (priority !== undefined) lines.push(`Priority: ${priority.slice(0, 60)}`);
  const url = text('url', mapping, row);
  if (url !== undefined && /^https?:\/\//iu.test(url)) lines.push(`Notion: ${url.slice(0, 500)}`);
  return lines.length === 0 ? null : lines.join('\n\n').slice(0, MAX_DESCRIPTION);
}
