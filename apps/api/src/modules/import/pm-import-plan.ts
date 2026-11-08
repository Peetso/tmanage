/**
 * R45 L3 (54-25) — the pure half of the Trello / Asana token import: what the owner's mapping
 * makes of the cards read from the source.
 *
 * - **Status**: a list / section name maps to one of {@link PM_TARGET_STATES} (the owner's map,
 *   else a suggestion from the name). A completed card or task is `done` whatever its list.
 * - **People**: a source person maps to a TManage member by e-mail (the suggestion, exact match
 *   only) or by the owner's explicit pick; anything else imports unassigned and is counted.
 * - **Idempotency**: every imported description ends with a provenance line naming the card's
 *   address at the source. A re-run reads the markers already in the target project and skips
 *   those cards, so running the same import twice creates nothing new.
 */

import type { PmBoardData, PmCard, PmComment, PmSource } from './pm-sources.js';
import { MAX_PM_BOARDS, isPmBoardId } from './pm-sources.js';

export const PM_TARGET_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'internal_review',
  'done',
] as const;
export type PmTargetState = (typeof PM_TARGET_STATES)[number];

/** Longest description written (the text column holds more; this keeps an item readable). */
export const MAX_PM_DESCRIPTION = 20_000;
/** The work-comment route's own bound. */
export const MAX_PM_COMMENT = 5000;

const SOURCE_NAME: Readonly<Record<PmSource, string>> = { trello: 'Trello', asana: 'Asana' };

/** The status a list / section name suggests. */
export function suggestState(name: string): PmTargetState {
  const n = name.toLowerCase();
  if (/\b(done|complete[d]?|closed|finished|shipped)\b/u.test(n)) return 'done';
  if (/\b(review|qa|testing|approval)\b/u.test(n)) return 'internal_review';
  if (/\b(doing|in progress|progress|working|wip|started)\b/u.test(n)) return 'in_progress';
  if (/\b(to ?do|ready|next|up next|planned)\b/u.test(n)) return 'ready';
  return 'backlog';
}

/** The provenance line appended to every imported description. */
export function provenanceLine(source: PmSource, url: string): string {
  return `Imported from ${SOURCE_NAME[source]}: ${url}`;
}

const MARKER =
  /Imported from (?:Trello|Asana): (https:\/\/(?:trello\.com\/c\/[A-Za-z0-9]{1,24}|app\.asana\.com\/0\/\d{1,30}\/\d{1,30}))/gu;

/** The source addresses already imported, read from existing descriptions. */
export function extractMarkers(descriptions: readonly (string | null)[]): Set<string> {
  const found = new Set<string>();
  for (const description of descriptions) {
    if (description === null) continue;
    for (const match of description.matchAll(MARKER)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return found;
}

export interface PmImportOptions {
  readonly projectId: string;
  readonly boardIds: readonly string[];
  /** List / section name → target state. */
  readonly statusMap: Readonly<Record<string, PmTargetState>>;
  /** Person key → TManage user id, or `null` to leave unassigned. */
  readonly userMap: Readonly<Record<string, string | null>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isState(value: unknown): value is PmTargetState {
  return typeof value === 'string' && (PM_TARGET_STATES as readonly string[]).includes(value);
}

/** The owner's choices, checked; `details` collects every refusal. */
export function parsePmImportOptions(
  source: PmSource,
  body: Readonly<Record<string, unknown>> | undefined,
  details: { field: string; message: string }[],
): PmImportOptions | null {
  const projectId = body?.['projectId'];
  if (typeof projectId !== 'string' || !UUID.test(projectId)) {
    details.push({ field: 'projectId', message: 'must be a project id' });
  }
  const rawBoards = body?.['boardIds'];
  const boardIds = Array.isArray(rawBoards) ? [...new Set(rawBoards)] : [];
  if (
    boardIds.length === 0 ||
    boardIds.length > MAX_PM_BOARDS ||
    !boardIds.every((id) => isPmBoardId(source, id))
  ) {
    details.push({ field: 'boardIds', message: 'choose between 1 and 10 boards' });
  }
  const statusMap: Record<string, PmTargetState> = {};
  const rawStatus = body?.['statusMap'] ?? {};
  if (typeof rawStatus !== 'object' || rawStatus === null || Array.isArray(rawStatus)) {
    details.push({ field: 'statusMap', message: 'must be an object' });
  } else {
    for (const [name, state] of Object.entries(rawStatus).slice(0, 500)) {
      if (name.length > 120 || !isState(state)) {
        details.push({ field: 'statusMap', message: 'unknown status' });
        break;
      }
      statusMap[name] = state;
    }
  }
  const userMap: Record<string, string | null> = {};
  const rawUsers = body?.['userMap'] ?? {};
  if (typeof rawUsers !== 'object' || rawUsers === null || Array.isArray(rawUsers)) {
    details.push({ field: 'userMap', message: 'must be an object' });
  } else {
    for (const [key, userId] of Object.entries(rawUsers).slice(0, 500)) {
      if (
        key.length > 254 ||
        (userId !== null && (typeof userId !== 'string' || !UUID.test(userId)))
      ) {
        details.push({ field: 'userMap', message: 'unknown person' });
        break;
      }
      userMap[key] = userId;
    }
  }
  if (details.length > 0) return null;
  return { projectId: projectId as string, boardIds: boardIds as string[], statusMap, userMap };
}

export interface PmMappingSuggestion {
  readonly statusMap: Readonly<Record<string, PmTargetState>>;
  /** Only people matched by an exact e-mail; the rest are absent (unassigned unless picked). */
  readonly userMap: Readonly<Record<string, string>>;
}

/** The default mapping the screen starts from. */
export function suggestPmMapping(
  data: PmBoardData,
  userIdByEmail: ReadonlyMap<string, string>,
): PmMappingSuggestion {
  const statusMap: Record<string, PmTargetState> = {};
  for (const container of data.containers) statusMap[container] = suggestState(container);
  const userMap: Record<string, string> = {};
  for (const person of data.people) {
    const userId = person.email === null ? undefined : userIdByEmail.get(person.email);
    if (userId !== undefined) userMap[person.key] = userId;
  }
  return { statusMap, userMap };
}

export interface PmPlanItem {
  readonly card: PmCard;
  readonly title: string;
  readonly description: string;
  readonly state: PmTargetState;
  readonly ownerUserId: string | null;
  readonly dueAt: Date | null;
  /** Comment bodies, oldest first, already formatted and bounded. */
  readonly comments: readonly string[];
}

export interface PmPlan {
  readonly items: readonly PmPlanItem[];
  readonly counts: {
    readonly cards: number;
    /** `null` when comments were not read (Asana preview). */
    readonly comments: number | null;
    readonly dueDates: number;
    readonly assigned: number;
    readonly alreadyImported: number;
    readonly archivedSkipped: number;
  };
  /** Containers with no explicit mapping (they used the suggestion). */
  readonly unmappedContainers: readonly string[];
  /** Person keys on cards that map to nobody. */
  readonly unmatchedPeople: readonly string[];
  readonly truncated: boolean;
}

export function formatPmComment(comment: PmComment): string {
  const head = [comment.authorName || 'Someone', comment.createdAt?.slice(0, 10) ?? null]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  const body = `**${head}**\n\n${comment.text}`;
  return body.length > MAX_PM_COMMENT ? `${body.slice(0, MAX_PM_COMMENT - 1)}…` : body;
}

function describe(source: PmSource, card: PmCard): string {
  const line = provenanceLine(source, card.url);
  const room = MAX_PM_DESCRIPTION - line.length - 8;
  const body = card.description?.trim() ?? '';
  const kept = body.length > room ? `${body.slice(0, room - 1)}…` : body;
  return kept === '' ? line : `${kept}\n\n---\n${line}`;
}

/**
 * The work items the import would create. `activeUserIds` are the organization's active members:
 * a mapped user who is not one imports unassigned.
 */
export function buildPmPlan(
  source: PmSource,
  data: PmBoardData,
  options: Pick<PmImportOptions, 'statusMap' | 'userMap'>,
  existing: { readonly markers: ReadonlySet<string>; readonly activeUserIds: ReadonlySet<string> },
): PmPlan {
  const items: PmPlanItem[] = [];
  const unmapped = new Set<string>();
  const unmatched = new Set<string>();
  let alreadyImported = 0;
  let archivedSkipped = 0;
  let comments: number | null = 0;
  for (const card of data.cards) {
    if (card.archived) {
      archivedSkipped += 1;
      continue;
    }
    if (existing.markers.has(card.url)) {
      alreadyImported += 1;
      continue;
    }
    let state: PmTargetState = 'backlog';
    if (card.completed) state = 'done';
    else if (card.container !== null) {
      const mapped = options.statusMap[card.container];
      if (mapped === undefined) unmapped.add(card.container);
      state = mapped ?? suggestState(card.container);
    }
    let owner: string | null = null;
    for (const key of card.assigneeKeys) {
      const userId = options.userMap[key];
      if (typeof userId === 'string' && existing.activeUserIds.has(userId)) {
        owner = userId;
        break;
      }
    }
    if (owner === null) card.assigneeKeys.forEach((key) => unmatched.add(key));
    if (card.comments === null) comments = null;
    else if (comments !== null) comments += card.comments.length;
    items.push({
      card,
      title: card.title,
      description: describe(source, card),
      state,
      ownerUserId: owner,
      dueAt: card.dueOn === null ? null : new Date(`${card.dueOn}T00:00:00.000Z`),
      comments: (card.comments ?? []).map(formatPmComment),
    });
  }
  return {
    items,
    counts: {
      cards: items.length,
      comments,
      dueDates: items.filter((i) => i.dueAt !== null).length,
      assigned: items.filter((i) => i.ownerUserId !== null).length,
      alreadyImported,
      archivedSkipped,
    },
    unmappedContainers: [...unmapped],
    unmatchedPeople: [...unmatched],
    truncated: data.truncated,
  };
}
