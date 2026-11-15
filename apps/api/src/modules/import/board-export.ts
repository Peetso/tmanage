/**
 * 54-26 — the monday.com and ClickUp file importers, pure half.
 *
 * Governing source: `54-FEATURE-GAPS-PLATFORM-ECOSYSTEM.md` §10.3 **54-26**. Both sources are
 * read from their standard export, never an API: a monday board exported to Excel (the web client
 * flattens the group blocks and the sub-item rows into one table) and a ClickUp task CSV. As for
 * Notion and Jira, the web client parses the file and the API sees JSON rows bounded by
 * `MAX_IMPORT_ROWS`; the caller's `mapping` names the column for each of {@link BOARD_FIELDS}.
 *
 * What this file decides, without I/O or a clock:
 * - title: required, ≤ 300 characters (`work_items.title` / `work_item_subtasks.title`);
 * - group (monday group / ClickUp list): becomes a work label, so the items stay grouped.
 *   Deviation from the plan text ("groups → phases"): a TManage phase holds no work items, so a
 *   phase would lose the grouping; the label keeps it and the receipt says so;
 * - status: the caller's `statusMap` first, then the Arabic defaults below, then the Trello /
 *   Asana name rule (`suggestState`); an unknown status lands in `backlog` with a note;
 * - person: the first person of the cell is the owner — matched by e-mail when the cell holds
 *   one, else by display name (the commit resolves; no account linking by guess);
 * - dates: ISO, `March 4, 2026`, a ClickUp epoch-milliseconds stamp, or a monday timeline
 *   `2026-03-04 - 2026-03-09` (start and due);
 * - sub-items / subtasks: a row whose parent cell names another row of the batch (by item id,
 *   else by name) becomes a subtask of that row's work item; nested subtasks hang off the root;
 * - comments: a ClickUp `Comments` cell (JSON list or plain text) or a monday `Updates` cell
 *   becomes work comments, bounded per item.
 */

import type { WorkItemState } from '@tmanage/domain';
import type { FieldError, SourceMapping, SourceRow } from './import-validation.js';
import { MAX_LABEL_NAME, isJiraTargetState } from './jira-issues.js';
import { parseNotionDate, splitTags } from './notion-database.js';
import { MAX_PM_COMMENT, suggestState } from './pm-import-plan.js';

/** Target field → the export columns that carry it by default (monday, then ClickUp names). */
export const BOARD_FIELDS = {
  name: ['Name', 'Item', 'Task Name'],
  group: ['Group', 'List Name'],
  status: ['Status'],
  person: ['Person', 'People', 'Owner', 'Assignees', 'Assignee'],
  date: ['Date', 'Timeline'],
  startDate: ['Start Date'],
  dueDate: ['Due Date', 'Due date'],
  tags: ['Tags'],
  priority: ['Priority'],
  description: ['Text', 'Notes', 'Description', 'Task Content'],
  itemId: ['Item ID', 'Task ID'],
  parent: ['Parent item', 'Parent ID'],
  comments: ['Updates', 'Comments'],
} as const;
export type BoardField = keyof typeof BOARD_FIELDS;

export const MAX_BOARD_TITLE = 300;
const MAX_DESCRIPTION = 20_000;
const MAX_TAGS = 20;
const MAX_PERSON = 500;
const MAX_REF = 64;
const MAX_COMMENTS_CELL = 100_000;
/** Comments written per item; the rest are counted in a note. */
export const MAX_BOARD_COMMENTS = 50;
/** How far a nested subtask chain is walked to its root. */
const MAX_DEPTH = 10;

function cell(field: BoardField, mapping: SourceMapping, row: SourceRow): unknown {
  const mapped = mapping[field];
  if (mapped !== undefined) return row[mapped];
  for (const alias of BOARD_FIELDS[field]) {
    if (alias in row) return row[alias];
  }
  return undefined;
}

function text(field: BoardField, mapping: SourceMapping, row: SourceRow): string | undefined {
  const value = cell(field, mapping, row);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** One date: an epoch-milliseconds stamp (ClickUp) or anything the Notion reader takes. */
function parseOneDate(value: string): string | null {
  if (/^\d{12,13}$/u.test(value)) {
    const parsed = new Date(Number(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  const single = parseNotionDate(value);
  return single === undefined || single === null || single.start !== null ? null : single.end;
}

/**
 * A board date cell. `undefined` when empty, `null` when present but not a date (or a range that
 * ends before it starts), else `{ start, end }` — `start` only for a timeline range.
 */
export function parseBoardDate(
  value: unknown,
): { readonly start: string | null; readonly end: string } | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parts = trimmed.split(/\s+-\s+|\s*(?:→|->)\s*/u);
  if (parts.length > 2) return null;
  if (parts.length === 1) {
    const one = parseOneDate(trimmed);
    return one === null ? null : { start: null, end: one };
  }
  const start = parseOneDate(parts[0] ?? '');
  const end = parseOneDate(parts[1] ?? '');
  if (start === null || end === null || end < start) return null;
  return { start, end };
}

/** People in a cell (`[Ana, Omar]`, `ana@x.com, omar@x.com`); e-mails lower-cased. */
export function splitPeople(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .replace(/^\[|\]$/gu, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => (part.includes('@') ? part.toLowerCase() : part));
}

export interface BoardComment {
  readonly author: string | null;
  readonly date: string | null;
  readonly text: string;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A comments cell: a JSON list (`[{ "text", "by", "date" }]` or strings), else one comment. */
export function parseBoardComments(value: string | undefined): readonly BoardComment[] {
  if (value === undefined) return [];
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.flatMap((entry): BoardComment[] => {
          if (typeof entry === 'string') {
            return entry.trim() === '' ? [] : [{ author: null, date: null, text: entry.trim() }];
          }
          if (typeof entry !== 'object' || entry === null) return [];
          const record = entry as Record<string, unknown>;
          const body = str(record['text']) ?? str(record['comment']);
          if (body === null) return [];
          return [
            {
              author: str(record['by']) ?? str(record['user']) ?? str(record['author']),
              date: str(record['date']),
              text: body,
            },
          ];
        });
      }
    } catch {
      // Not JSON: the whole cell is one comment.
    }
  }
  return [{ author: null, date: null, text: value }];
}

/** Validate one board row; field errors name the target field. */
export function validateBoardRow(mapping: SourceMapping, row: SourceRow): readonly FieldError[] {
  const errors: FieldError[] = [];
  const title = text('name', mapping, row);
  if (title === undefined) errors.push({ field: 'name', message: 'must be a non-empty string' });
  else if (title.length > MAX_BOARD_TITLE) {
    errors.push({ field: 'name', message: `must be ${MAX_BOARD_TITLE} characters or fewer` });
  }
  for (const field of ['date', 'startDate', 'dueDate'] as const) {
    if (parseBoardDate(cell(field, mapping, row)) === null) {
      errors.push({ field, message: 'must be a date like 2026-03-04 or a range' });
    }
  }
  const tags = splitTags(text('tags', mapping, row));
  if (tags.length > MAX_TAGS)
    errors.push({ field: 'tags', message: `must be ${MAX_TAGS} tags or fewer` });
  if (tags.some((tag) => tag.length > MAX_LABEL_NAME)) {
    errors.push({
      field: 'tags',
      message: `each tag must be ${MAX_LABEL_NAME} characters or fewer`,
    });
  }
  const group = text('group', mapping, row);
  if (group !== undefined && group.length > MAX_LABEL_NAME) {
    errors.push({ field: 'group', message: `must be ${MAX_LABEL_NAME} characters or fewer` });
  }
  const bounded: readonly [BoardField, number][] = [
    ['person', MAX_PERSON],
    ['itemId', MAX_REF],
    ['parent', MAX_REF * 5],
    ['description', MAX_DESCRIPTION],
    ['comments', MAX_COMMENTS_CELL],
  ];
  for (const [field, max] of bounded) {
    const value = cell(field, mapping, row);
    if (typeof value === 'string' && value.length > max) {
      errors.push({ field, message: `must be ${max} characters or fewer` });
    }
  }
  return errors;
}

/** monday / ClickUp status labels in Arabic (their status names are free text). */
const ARABIC_STATES: Readonly<Record<string, WorkItemState>> = {
  'لم يبدأ': 'backlog',
  'لم تبدأ': 'backlog',
  'قائمة الانتظار': 'backlog',
  للتنفيذ: 'ready',
  جاهز: 'ready',
  'قيد التنفيذ': 'in_progress',
  'قيد العمل': 'in_progress',
  'جار العمل عليه': 'in_progress',
  'جاري العمل عليه': 'in_progress',
  متوقف: 'in_progress',
  'قيد المراجعة': 'internal_review',
  تم: 'done',
  منجز: 'done',
  مكتمل: 'done',
  مغلق: 'done',
};

/** A board status as a work state; `unmapped` is true when the default had to be used. */
export function mapBoardStatus(
  status: string | undefined,
  statusMap: Readonly<Record<string, string>> = {},
): { readonly state: WorkItemState; readonly unmapped: boolean } {
  if (status === undefined) return { state: 'backlog', unmapped: false };
  const mapped = statusMap[status];
  if (isJiraTargetState(mapped)) return { state: mapped, unmapped: false };
  const key = status.trim().toLowerCase();
  const arabic = ARABIC_STATES[key];
  if (arabic) return { state: arabic, unmapped: false };
  if (key === 'stuck') return { state: 'in_progress', unmapped: false };
  const suggested = suggestState(key);
  return {
    state: suggested,
    unmapped: suggested === 'backlog' && !/\b(backlog|open)\b/u.test(key),
  };
}

export interface BoardItemPlan {
  readonly rowIndex: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: WorkItemState;
  readonly startOn: string | null;
  readonly dueOn: string | null;
  /** Tags plus the group name. */
  readonly labels: readonly string[];
  /** The first person: an e-mail (lower case) or a display name; `null` for none. */
  readonly person: string | null;
  readonly comments: readonly string[];
}

export interface BoardSubitemPlan {
  readonly rowIndex: number;
  /** The row of the work item this subtask hangs off. */
  readonly parentRowIndex: number;
  readonly title: string;
  readonly done: boolean;
}

export interface BoardCommitPlan {
  readonly items: readonly BoardItemPlan[];
  readonly subitems: readonly BoardSubitemPlan[];
  /** Every distinct label of the batch, in first-seen order. */
  readonly labels: readonly string[];
  /** Every distinct person of the batch. */
  readonly people: readonly string[];
  /** `board_status_unmapped:<names>`, `board_parent_unmatched:<n>`, `board_comments_capped:<n>`. */
  readonly notes: readonly string[];
}

function formatComment(comment: BoardComment): string {
  const head = [comment.author ?? 'Someone', comment.date?.slice(0, 10) ?? null]
    .filter((part) => part !== null)
    .join(' · ');
  return `**${head}**\n\n${comment.text}`.slice(0, MAX_PM_COMMENT);
}

/** The description plus the priority, which has no column of its own. */
function describe(mapping: SourceMapping, row: SourceRow): string | null {
  const lines: string[] = [];
  const body = text('description', mapping, row);
  if (body !== undefined) lines.push(body);
  const priority = text('priority', mapping, row);
  if (priority !== undefined) lines.push(`Priority: ${priority.slice(0, 60)}`);
  return lines.length === 0 ? null : lines.join('\n\n').slice(0, MAX_DESCRIPTION);
}

/** The plan for the **valid** rows of a monday / ClickUp batch. */
export function boardCommitPlan(
  mapping: SourceMapping,
  rows: readonly { readonly rowIndex: number; readonly row: SourceRow }[],
  options: { readonly statusMap?: Readonly<Record<string, string>> } = {},
): BoardCommitPlan {
  // The parent of each row, as a row index of this batch (by item id first, then by name).
  const byId = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const { rowIndex, row } of rows) {
    const id = text('itemId', mapping, row);
    if (id !== undefined && !byId.has(id)) byId.set(id, rowIndex);
    const name = text('name', mapping, row);
    if (name !== undefined && text('parent', mapping, row) === undefined && !byName.has(name)) {
      byName.set(name, rowIndex);
    }
  }
  const rowByIndex = new Map(rows.map((r) => [r.rowIndex, r.row] as const));
  const parentOf = (row: SourceRow): number | null => {
    const ref = text('parent', mapping, row);
    if (ref === undefined) return null;
    return byId.get(ref) ?? byName.get(ref) ?? null;
  };
  /** The top-level ancestor of a row, or `null` when its chain leaves the batch or loops. */
  const rootOf = (rowIndex: number): number | null => {
    let current = rowIndex;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const row = rowByIndex.get(current);
      if (row === undefined) return null;
      const parent = parentOf(row);
      if (parent === null) return current === rowIndex ? null : current;
      if (parent === rowIndex) return null;
      current = parent;
    }
    return null;
  };

  const unmapped = new Set<string>();
  const labels = new Set<string>();
  const people = new Set<string>();
  let parentUnmatched = 0;
  let commentsCapped = 0;
  const items: BoardItemPlan[] = [];
  const subitems: BoardSubitemPlan[] = [];
  for (const { rowIndex, row } of rows) {
    const status = text('status', mapping, row);
    const mapped = mapBoardStatus(status, options.statusMap);
    if (mapped.unmapped && status !== undefined) unmapped.add(status);
    const title = text('name', mapping, row) ?? '';
    if (text('parent', mapping, row) !== undefined) {
      const root = rootOf(rowIndex);
      if (root !== null) {
        subitems.push({ rowIndex, parentRowIndex: root, title, done: mapped.state === 'done' });
        continue;
      }
      parentUnmatched += 1;
    }
    const group = text('group', mapping, row);
    const rowLabels = [
      ...new Set([
        ...(group === undefined ? [] : [group]),
        ...splitTags(text('tags', mapping, row)),
      ]),
    ];
    rowLabels.forEach((label) => labels.add(label));
    const person = splitPeople(text('person', mapping, row))[0] ?? null;
    if (person !== null) people.add(person);
    const comments = parseBoardComments(text('comments', mapping, row));
    if (comments.length > MAX_BOARD_COMMENTS) commentsCapped += 1;
    const range =
      parseBoardDate(cell('date', mapping, row)) ??
      parseBoardDate(cell('dueDate', mapping, row)) ??
      null;
    const start = parseBoardDate(cell('startDate', mapping, row)) ?? null;
    items.push({
      rowIndex,
      title,
      description: describe(mapping, row),
      state: mapped.state,
      startOn: range?.start ?? start?.end ?? null,
      dueOn: range?.end ?? null,
      labels: rowLabels,
      person,
      comments: comments.slice(0, MAX_BOARD_COMMENTS).map(formatComment),
    });
  }
  const notes: string[] = [];
  if (unmapped.size > 0) notes.push(`board_status_unmapped:${[...unmapped].sort().join(', ')}`);
  if (parentUnmatched > 0) notes.push(`board_parent_unmatched:${parentUnmatched}`);
  if (commentsCapped > 0) notes.push(`board_comments_capped:${commentsCapped}`);
  return { items, subitems, labels: [...labels], people: [...people], notes };
}
