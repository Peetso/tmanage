import type { WorkItemState } from '@tmanage/domain';
import type { CapsuleState } from '@tmanage/ui';
import type { WorkItemAudience } from './api/work-items';
import { formatDateTime, formatDay as formatLocalizedDay } from './i18n/format';
import { activeLocale } from './i18n/locale-store';
import { translate, type MessageKey } from './i18n/t';

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

/*
 * The words come from the catalog, in the active language: an Arabic reader saw "Blocked" and
 * "Done" in the state capsules of every work screen (ACT-11, NFR-02). The work list's filter keys
 * are the one wording already shipped in both catalogs, so the capsule and the chip agree.
 */
const STATE_LABEL_KEY: Record<WorkItemState, MessageKey> = {
  backlog: 'WorkListScreen.stateBacklog',
  ready: 'WorkListScreen.stateReady',
  in_progress: 'WorkListScreen.stateInProgress',
  blocked: 'WorkListScreen.stateBlocked',
  internal_review: 'WorkListScreen.stateInternalReview',
  done: 'WorkListScreen.stateDone',
  archived: 'WorkListScreen.stateArchived',
};

export function stateCapsule(state: WorkItemState): CapsuleState {
  return STATE_CAPSULE[state] ?? 'neutral';
}

export function stateLabel(state: WorkItemState, locale: string = activeLocale.get()): string {
  const key = STATE_LABEL_KEY[state];
  return key === undefined ? state : translate(locale, key);
}

/**
 * The audience, in words a person would use out loud.
 *
 * "Internal" is not "private" and "Client can see" is not "public": a work item widened to
 * `client_visible` is visible to *this project's* client and to nobody else. The wording says
 * who, because a screen that said "public" would describe a disclosure that never happens.
 */
const AUDIENCE_LABEL_KEY: Record<WorkItemAudience, MessageKey> = {
  internal: 'WorkItemAudience.internal',
  client_visible: 'WorkItemAudience.clientVisible',
  client_action_required: 'WorkItemAudience.clientActionRequired',
};

export function audienceLabel(
  audience: WorkItemAudience,
  locale: string = activeLocale.get(),
): string {
  const key = AUDIENCE_LABEL_KEY[audience];
  return key === undefined ? audience : translate(locale, key);
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
  if (value === null) return translate(activeLocale.get(), 'WorkItemAudience.noDate');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  // One localized format, in the member's saved language — not `undefined`, which formats in
  // whatever locale the browser happens to be in and leaves Arabic readers with Latin digits that
  // scramble against the right-to-left text (WRK-13). The shared `format.ts` wrapper is the single
  // implementation every screen shares; it reads the active locale from the store here so a plain
  // call site stays a plain call site.
  return formatDateTime(value, { locale: activeLocale.get() });
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
  if (value === null) return translate(activeLocale.get(), 'WorkItemAudience.noDate');
  const bare = value.length === 10;
  const iso = bare ? `${value}T00:00:00.000Z` : value;
  if (Number.isNaN(new Date(iso).getTime())) return value;
  // Same shared, member-locale formatter as {@link formatInstant} (WRK-13). A bare calendar date
  // is still pinned to UTC so no reader's zone moves it onto the wrong day; a full instant keeps
  // the reader's own zone, which is the existing, deliberate behaviour.
  const locale = activeLocale.get();
  return bare
    ? formatLocalizedDay(iso, { locale, timeZone: 'UTC' })
    : formatLocalizedDay(iso, { locale });
}

/**
 * The `YYYY-MM-DD` a date control holds for a stored instant, or `''` for none. The UTC calendar
 * day of the instant, which is the day {@link dayToInstant} wrote.
 */
export function instantToDay(value: string | null): string {
  if (value === null) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/**
 * The instant the API stores for a picked calendar day, or `null` when the control is cleared.
 * Noon UTC, so the day {@link formatDay} prints back is the day picked in every zone from
 * UTC-11 to UTC+11 rather than sliding to the day before or after.
 */
export function dayToInstant(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T12:00:00.000Z`;
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
