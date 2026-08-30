import type { WorkItemState } from '@tmanage/domain';
import type { CapsuleState } from '@tmanage/ui';
import type { WorkItemAudience } from './api/work-items';

/**
 * How a work item's state and audience are *said*, in one place.
 *
 * Three screens render the same two values — the list, the detail and the project overview —
 * and law 3 of the token export is that every state using colour also carries a word. If each
 * screen chose its own word, the colour would be the only thing they agreed on, which is
 * exactly the failure the law exists to prevent.
 *
 * The capsule states are the design system's vocabulary, not the domain's: `internal_review`
 * is a `waiting` capsule because that is what it looks like to whoever is waiting on it, and
 * `backlog` is `neutral` rather than `future` because `future` is reserved for things that
 * are scheduled. The mapping is deliberate and lives here so it can be read in one screen.
 */

const STATE_CAPSULE: Record<WorkItemState, CapsuleState> = {
  backlog: 'neutral',
  ready: 'future',
  in_progress: 'current',
  blocked: 'blocked',
  internal_review: 'waiting',
  done: 'done',
  archived: 'archived',
};

const STATE_LABEL: Record<WorkItemState, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  internal_review: 'Internal review',
  done: 'Done',
  archived: 'Archived',
};

export function stateCapsule(state: WorkItemState): CapsuleState {
  return STATE_CAPSULE[state] ?? 'neutral';
}

export function stateLabel(state: WorkItemState): string {
  return STATE_LABEL[state] ?? state;
}

/**
 * The audience, in words a person would use out loud.
 *
 * "Internal" is not "private" and "Client can see" is not "public": a work item widened to
 * `client_visible` is visible to *this project's* client and to nobody else. The wording says
 * who, because a screen that said "public" would describe a disclosure that never happens.
 */
const AUDIENCE_LABEL: Record<WorkItemAudience, string> = {
  internal: 'Internal',
  client_visible: 'Client can see',
  client_action_required: 'Client action needed',
};

export function audienceLabel(audience: WorkItemAudience): string {
  return AUDIENCE_LABEL[audience] ?? audience;
}

/** `internal` is the only audience a client principal never sees. */
export function isClientFacing(audience: WorkItemAudience): boolean {
  return audience !== 'internal';
}

/**
 * A date, or the word for not having one.
 *
 * `null` prints as "No date" rather than as an empty cell: an empty cell in a table reads as
 * missing data — something that failed to load — and "no due date" is a real, common and
 * legitimate state for a work item to be in.
 */
export function formatInstant(value: string | null): string {
  if (value === null) return 'No date';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    parsed,
  );
}

/**
 * The same, without a time of day. Used where only the day matters.
 *
 * A bare `'YYYY-MM-DD'` — the shape `DATE` columns return since 0012 — is a calendar date,
 * pinned to midnight UTC and formatted in UTC so no reader's zone moves it. A full instant
 * keeps the reader's own zone: an instant genuinely happens on different dates in different
 * places, and pretending otherwise would be the same lie in the other direction.
 */
export function formatDay(value: string | null): string {
  if (value === null) return 'No date';
  const bare = value.length === 10;
  const parsed = new Date(bare ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    ...(bare ? { timeZone: 'UTC' } : {}),
  }).format(parsed);
}

/**
 * Is this item past its due date and not finished?
 *
 * `done` and `archived` are excluded deliberately. An item delivered a day late is not
 * "overdue" once it is delivered, and a list that kept shouting about it would train people
 * to ignore the signal on the items that are still open.
 */
export function isOverdue(
  item: { readonly dueAt: string | null; readonly state: WorkItemState },
  now: Date,
): boolean {
  if (item.dueAt === null) return false;
  if (item.state === 'done' || item.state === 'archived') return false;
  const due = new Date(item.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < now.getTime();
}
