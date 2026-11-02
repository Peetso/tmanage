/**
 * R21-e (54-27) — the Jira CSV importer, pure half.
 *
 * Governing source: `54-FEATURE-GAPS-PLATFORM-ECOSYSTEM.md` §10.4 **54-27**. A Jira "All fields"
 * CSV export arrives as rows (the web client parses the file; the API sees JSON rows bounded by
 * `MAX_IMPORT_ROWS`), and the caller's `mapping` names the CSV header that carries each of
 * {@link JIRA_FIELDS}. Only `issueKey` and `summary` are required.
 *
 * What this file decides, without I/O or a clock:
 * - keys: `WEB-123` is parsed into its prefix and number, and every row of one batch must share
 *   one prefix (`mixed_prefixes` otherwise) so the commit can keep the keys through 54-10's
 *   `work_key_prefix` — `WEB-123` stays `WEB-123`;
 * - statuses: by Jira's status **category** first (To Do / In Progress / Done), with the caller's
 *   `statusMap[status]` overriding, and an unknown status landing in `backlog` with a row note;
 * - types: Task / Bug / Story become `task` with a `type:<name>` note, a sub-task becomes a
 *   `task` that keeps its `parent` key, and an Epic creates **no item** — it is recorded so the
 *   commit can turn it into a label on its children;
 * - sprints: Jira emits one `Sprint` column per sprint an issue passed through; the **last** one
 *   is the issue's sprint. Deviation from the plan text ("sprints → `sprint:12` labels"): since
 *   0306 (R19-d) iterations are a TManage concept, so sprints become **iterations**. Jira's CSV
 *   carries sprint names only, so an iteration's window is derived from its issues' created /
 *   due dates ({@link sprintWindow}) and the receipt says so (`sprint_dates_derived`).
 *
 * Not here: worklogs (never imported — privacy), story points, attachments, comments, the REST
 * path and its ADF converter (later slices).
 */

import { WORK_ITEM_STATES, normalizeWorkKeyPrefix } from '@tmanage/domain';
import type { WorkItemState } from '@tmanage/domain';
import type { FieldError, SourceMapping, SourceRow } from './import-validation.js';

/** The target fields a Jira mapping may name. */
export const JIRA_FIELDS = [
  'issueKey',
  'summary',
  'issueType',
  'status',
  'statusCategory',
  'priority',
  'assigneeEmail',
  'sprint',
  'parent',
  'description',
  'created',
  'dueDate',
] as const;
export type JiraField = (typeof JIRA_FIELDS)[number];

/** `work_items.title` is `VARCHAR(300)`. */
const MAX_TITLE = 300;
/** `iterations.name` and `work_item_labels.name` are `VARCHAR(120)`. */
export const MAX_SPRINT_NAME = 120;
export const MAX_LABEL_NAME = 120;
/** A description is `TEXT`; bounded well under 64 KiB so a multi-byte body still fits. */
const MAX_DESCRIPTION = 20_000;
const MAX_SHORT_TEXT = 190;

/**
 * The states a status may map to. `blocked` needs a reason and an ask the CSV does not carry,
 * and `archived` is not a status a live Jira issue has, so neither is a mapping target.
 */
export const JIRA_TARGET_STATES = WORK_ITEM_STATES.filter(
  (state) => state !== 'blocked' && state !== 'archived',
) as readonly WorkItemState[];

export function isJiraTargetState(value: unknown): value is WorkItemState {
  return typeof value === 'string' && (JIRA_TARGET_STATES as readonly string[]).includes(value);
}

const ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,9})-(\d{1,7})$/u;

export interface IssueKey {
  readonly prefix: string;
  readonly number: number;
}

/** `WEB-123` → `{ prefix: 'WEB', number: 123 }`; `null` for anything else (`web-123`, `WEB-`). */
export function parseIssueKey(value: unknown): IssueKey | null {
  if (typeof value !== 'string') return null;
  const match = ISSUE_KEY.exec(value.trim());
  if (!match) return null;
  const number = Number(match[2]);
  if (number < 1) return null;
  return { prefix: match[1] ?? '', number };
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

/**
 * A Jira date cell as `YYYY-MM-DD`. Accepts ISO (`2024-03-12`, `2024-03-12T10:15:00.000+0000`)
 * and the export's default `12/Mar/24 10:15 AM`. `undefined` when the cell is empty, `null` when
 * it is present but not a date.
 */
export function parseJiraDate(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/u.exec(text);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const jira = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s.*)?$/u.exec(text);
  if (jira) {
    const month = MONTHS[(jira[2] ?? '').toLowerCase()];
    if (month === undefined) return null;
    const rawYear = Number(jira[3]);
    const year = (jira[3] ?? '').length === 2 ? 2000 + rawYear : rawYear;
    return isoDate(year, month, Number(jira[1]));
  }
  return null;
}

function cell(field: JiraField, mapping: SourceMapping, row: SourceRow): unknown {
  const column = mapping[field];
  return column === undefined ? undefined : row[column];
}

function text(field: JiraField, mapping: SourceMapping, row: SourceRow): string | undefined {
  const value = cell(field, mapping, row);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The issue's sprint: the **last** non-empty `Sprint` value. Jira repeats the header once per
 * sprint; a CSV parser keeps them as an array cell or as suffixed columns (`Sprint_1`,
 * `Sprint.2`, `Sprint (3)`), and both shapes are read in column order.
 */
export function sprintOf(mapping: SourceMapping, row: SourceRow): string | undefined {
  const column = mapping['sprint'];
  if (column === undefined) return undefined;
  const suffixed: { order: number; value: unknown }[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === column) {
      suffixed.push({ order: 0, value });
      continue;
    }
    if (!key.startsWith(column)) continue;
    const rest = /^[\s_.]*\(?(\d+)\)?$/u.exec(key.slice(column.length));
    if (rest) suffixed.push({ order: Number(rest[1]), value });
  }
  suffixed.sort((a, b) => a.order - b.order);
  let last: string | undefined;
  for (const { value } of suffixed) {
    const values = Array.isArray(value) ? (value as unknown[]) : [value];
    for (const one of values) {
      if (typeof one === 'string' && one.trim() !== '') last = one.trim();
    }
  }
  return last;
}

function requireText(
  field: JiraField,
  value: string | undefined,
  max: number,
  errors: FieldError[],
): void {
  if (value === undefined) errors.push({ field, message: 'must be a non-empty string' });
  else if (value.length > max)
    errors.push({ field, message: `must be ${max} characters or fewer` });
}

function optionalText(
  field: JiraField,
  mapping: SourceMapping,
  row: SourceRow,
  max: number,
  errors: FieldError[],
): void {
  const value = cell(field, mapping, row);
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    errors.push({ field, message: 'must be a string' });
    return;
  }
  if (value.trim().length > max) {
    errors.push({ field, message: `must be ${max} characters or fewer` });
  }
}

/** Validate one Jira row against the target shape. */
export function validateJiraRow(mapping: SourceMapping, row: SourceRow): readonly FieldError[] {
  const errors: FieldError[] = [];
  const key = text('issueKey', mapping, row);
  if (key === undefined) errors.push({ field: 'issueKey', message: 'must be a non-empty string' });
  else if (parseIssueKey(key) === null) {
    errors.push({ field: 'issueKey', message: 'must be a Jira key like WEB-123' });
  }
  requireText('summary', text('summary', mapping, row), MAX_TITLE, errors);
  for (const field of ['issueType', 'status', 'statusCategory', 'priority'] as const) {
    optionalText(field, mapping, row, MAX_SHORT_TEXT, errors);
  }
  optionalText('assigneeEmail', mapping, row, 320, errors);
  optionalText('description', mapping, row, MAX_DESCRIPTION, errors);
  const parent = text('parent', mapping, row);
  if (parent !== undefined && parseIssueKey(parent) === null) {
    errors.push({ field: 'parent', message: 'must be a Jira key like WEB-12' });
  }
  const sprint = sprintOf(mapping, row);
  if (sprint !== undefined && sprint.length > MAX_SPRINT_NAME) {
    errors.push({ field: 'sprint', message: `must be ${MAX_SPRINT_NAME} characters or fewer` });
  }
  for (const field of ['created', 'dueDate'] as const) {
    if (parseJiraDate(cell(field, mapping, row)) === null) {
      errors.push({ field, message: 'must be a date (YYYY-MM-DD or 12/Mar/24)' });
    }
  }
  return errors;
}

/** A batch-level problem — one that no single row owns. */
export interface BatchError {
  readonly code: 'mixed_prefixes' | 'too_many_rows';
  readonly message: string;
}

/**
 * The prefix every parseable key in the batch shares, or a `mixed_prefixes` batch error. Rows
 * whose key does not parse are the row validator's problem, not this one's.
 */
export function onePrefix(
  mapping: SourceMapping,
  rows: readonly SourceRow[],
): { readonly prefix: string | null; readonly error: BatchError | null } {
  const prefixes = new Set<string>();
  for (const row of rows) {
    const key = parseIssueKey(text('issueKey', mapping, row));
    if (key) prefixes.add(key.prefix);
  }
  if (prefixes.size > 1) {
    return {
      prefix: null,
      error: {
        code: 'mixed_prefixes',
        message: `one Jira project per import; found ${[...prefixes].sort().join(', ')}`,
      },
    };
  }
  return { prefix: [...prefixes][0] ?? null, error: null };
}

const CATEGORY_STATES: Readonly<Record<string, WorkItemState>> = {
  'to do': 'backlog',
  todo: 'backlog',
  new: 'backlog',
  'in progress': 'in_progress',
  indeterminate: 'in_progress',
  done: 'done',
  complete: 'done',
};

export interface MappedStatus {
  readonly state: WorkItemState;
  readonly note: string | null;
}

/**
 * A Jira status as a work state: `statusMap[status]` wins, then the status category, then the
 * status name read as a category (a CSV without the category column), else `backlog` + a note.
 */
export function mapStatus(
  status: string | undefined,
  statusCategory: string | undefined,
  statusMap: Readonly<Record<string, string>> = {},
): MappedStatus {
  if (status !== undefined) {
    const mapped = statusMap[status];
    if (isJiraTargetState(mapped)) return { state: mapped, note: null };
  }
  const byCategory = CATEGORY_STATES[(statusCategory ?? '').trim().toLowerCase()];
  if (byCategory) return { state: byCategory, note: null };
  const byName = CATEGORY_STATES[(status ?? '').trim().toLowerCase()];
  if (byName) return { state: byName, note: null };
  if (status === undefined && statusCategory === undefined) return { state: 'backlog', note: null };
  return { state: 'backlog', note: `status_unmapped:${status ?? statusCategory ?? ''}` };
}

export type MappedType =
  | { readonly kind: 'epic' }
  | {
      readonly kind: 'item';
      readonly type: 'task';
      readonly subtask: boolean;
      readonly note: string | null;
    };

/** Task / Bug / Story → `task` (+ `type:<name>`); sub-task → `task` with its parent; Epic → none. */
export function mapType(issueType: string | undefined): MappedType {
  const name = (issueType ?? '').trim();
  const lower = name.toLowerCase();
  if (lower === 'epic') return { kind: 'epic' };
  if (lower === 'sub-task' || lower === 'subtask') {
    return { kind: 'item', type: 'task', subtask: true, note: null };
  }
  return {
    kind: 'item',
    type: 'task',
    subtask: false,
    note: name === '' || lower === 'task' ? null : `type:${name.slice(0, 60)}`,
  };
}

export interface SprintPlan {
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly rowIndexes: readonly number[];
}

/**
 * The derived window per sprint name: `startsOn` = the earliest `created`, `endsOn` = the latest
 * `dueDate ?? created` (never before `startsOn`). A sprint whose issues carry no dates at all
 * falls back to `fallbackDay` for both ends. Rows are `{ rowIndex, row }` so the plan keeps the
 * batch positions.
 */
export function sprintWindow(
  mapping: SourceMapping,
  rows: readonly { readonly rowIndex: number; readonly row: SourceRow }[],
  fallbackDay: string,
): readonly SprintPlan[] {
  const byName = new Map<string, { start?: string; end?: string; rowIndexes: number[] }>();
  for (const { rowIndex, row } of rows) {
    const name = sprintOf(mapping, row);
    if (name === undefined) continue;
    const entry = byName.get(name) ?? { rowIndexes: [] };
    entry.rowIndexes.push(rowIndex);
    const created = parseJiraDate(cell('created', mapping, row)) ?? undefined;
    const due = parseJiraDate(cell('dueDate', mapping, row)) ?? undefined;
    if (created !== undefined && (entry.start === undefined || created < entry.start)) {
      entry.start = created;
    }
    const end = due ?? created;
    if (end !== undefined && (entry.end === undefined || end > entry.end)) entry.end = end;
    byName.set(name, entry);
  }
  return [...byName.entries()].map(([name, entry]) => {
    const startsOn = entry.start ?? entry.end ?? fallbackDay;
    const end = entry.end ?? startsOn;
    return {
      name,
      startsOn,
      endsOn: end < startsOn ? startsOn : end,
      rowIndexes: entry.rowIndexes,
    };
  });
}

export interface JiraItemPlan {
  readonly rowIndex: number;
  readonly key: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly type: 'task';
  readonly state: WorkItemState;
  readonly assigneeEmail: string | null;
  readonly dueOn: string | null;
  readonly sprint: string | null;
  /** The Jira parent key (a sub-task's parent, or an epic) as given. */
  readonly parentKey: string | null;
  /** Set when the parent is an epic of this batch: the item gets that epic's label. */
  readonly epicKey: string | null;
  readonly notes: readonly string[];
}

export interface JiraEpicPlan {
  readonly rowIndex: number;
  readonly key: string;
  readonly labelName: string;
}

export interface JiraCommitPlan {
  readonly prefix: string | null;
  readonly items: readonly JiraItemPlan[];
  readonly sprints: readonly SprintPlan[];
  readonly epics: readonly JiraEpicPlan[];
  readonly notes: readonly string[];
}

export interface JiraPlanOptions {
  readonly statusMap?: Readonly<Record<string, string>>;
  /** `YYYY-MM-DD`, the window of a sprint whose issues carry no dates. */
  readonly today: string;
  /** Batches at the row cap get a "split by sprint" note. */
  readonly rowCap: number;
}

/**
 * The commit plan for the **valid** rows of a batch (`rows` carries their batch positions). The
 * commit half writes exactly this: one item per non-epic row, one iteration per sprint, one
 * label per epic.
 */
export function jiraCommitPlan(
  mapping: SourceMapping,
  rows: readonly { readonly rowIndex: number; readonly row: SourceRow }[],
  options: JiraPlanOptions,
): JiraCommitPlan {
  const { prefix } = onePrefix(
    mapping,
    rows.map((r) => r.row),
  );
  const epics: JiraEpicPlan[] = [];
  const itemRows: {
    rowIndex: number;
    row: SourceRow;
    type: Extract<MappedType, { kind: 'item' }>;
  }[] = [];
  for (const { rowIndex, row } of rows) {
    const type = mapType(text('issueType', mapping, row));
    if (type.kind === 'epic') {
      const key = text('issueKey', mapping, row) ?? '';
      const summary = text('summary', mapping, row) ?? key;
      epics.push({ rowIndex, key, labelName: summary.slice(0, MAX_LABEL_NAME) });
    } else {
      itemRows.push({ rowIndex, row, type });
    }
  }
  const epicKeys = new Set(epics.map((e) => e.key));

  let parentsUnlinked = false;
  const items = itemRows.map(({ rowIndex, row, type }): JiraItemPlan => {
    const key = text('issueKey', mapping, row) ?? '';
    const parsed = parseIssueKey(key);
    const status = mapStatus(
      text('status', mapping, row),
      text('statusCategory', mapping, row),
      options.statusMap,
    );
    const parentKey = text('parent', mapping, row) ?? null;
    const epicKey = parentKey !== null && epicKeys.has(parentKey) ? parentKey : null;
    if (parentKey !== null && epicKey === null) parentsUnlinked = true;
    const notes = [type.note, status.note].filter((n): n is string => n !== null);
    if (type.subtask) notes.push('subtask');
    return {
      rowIndex,
      key,
      number: parsed?.number ?? 0,
      title: text('summary', mapping, row) ?? key,
      description: text('description', mapping, row) ?? null,
      type: type.type,
      state: status.state,
      assigneeEmail: text('assigneeEmail', mapping, row)?.toLowerCase() ?? null,
      dueOn: parseJiraDate(cell('dueDate', mapping, row)) ?? null,
      sprint: sprintOf(mapping, row) ?? null,
      parentKey,
      epicKey,
      notes,
    };
  });

  const sprints = sprintWindow(
    mapping,
    itemRows.map(({ rowIndex, row }) => ({ rowIndex, row })),
    options.today,
  );
  const notes = ['worklogs_not_imported', 'story_points_not_imported'];
  if (sprints.length > 0) notes.unshift('sprint_dates_derived');
  if (parentsUnlinked) notes.push('parent_links_not_created');
  if (rows.length >= options.rowCap) notes.push('split_by_sprint');
  return { prefix, items, sprints, epics, notes };
}

/** Whether `prefix` can become a 54-10 `work_key_prefix` (2..10 Latin, no underscore). */
export function isKeepablePrefix(prefix: string): boolean {
  return normalizeWorkKeyPrefix(prefix) === prefix;
}
