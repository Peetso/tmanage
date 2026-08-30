import type { CapsuleState } from '@tmanage/ui';
import type { ClientRequestState } from './api/client-requests';

/**
 * How the **internal** lifecycle of a client request is said, in one place.
 *
 * A third presentation module, and the third is deliberate.
 * `client-request-presentation.ts` says the client's seven statuses;
 * `work-item-presentation.ts` says the work lifecycle; this says `23-ERD` §6's nine states as a
 * manager sees them. They are allowed to diverge — that is the whole reason the portal has a
 * vocabulary of its own — and one shared table is how a client eventually reads `triage`.
 *
 * The design artifact's `REQ-01 Request inbox` uses "Needs triage" for both `submitted` and
 * `triage`, and that is transcribed rather than improved: from the studio's side the difference
 * between "nobody has opened it" and "somebody has and has not answered" is real but is not
 * what the queue is sorted by. The **age** column carries the urgency instead.
 */

const STATE_CAPSULE: Record<ClientRequestState, CapsuleState> = {
  submitted: 'waiting',
  triage: 'waiting',
  needs_clarification: 'client',
  accepted: 'done',
  deferred: 'future',
  declined: 'blocked',
  planned: 'current',
  delivered: 'done',
  withdrawn: 'archived',
};

const STATE_LABEL: Record<ClientRequestState, string> = {
  submitted: 'Needs triage',
  triage: 'Needs triage',
  needs_clarification: 'Clarifying',
  accepted: 'Accepted',
  deferred: 'Deferred',
  declined: 'Declined',
  planned: 'Planned',
  delivered: 'Delivered',
  withdrawn: 'Withdrawn',
};

export function triageStateCapsule(state: ClientRequestState): CapsuleState {
  return STATE_CAPSULE[state] ?? 'neutral';
}

export function triageStateLabel(state: ClientRequestState): string {
  return STATE_LABEL[state] ?? state;
}

/** The four buckets the design's inbox counts, in its order. `withdrawn` is not one of them. */
export const TRIAGE_BUCKETS = [
  // `submitted` and `triage` together, because both are the studio's to act on. A request in
  // `needs_clarification` is waiting on the **client**, and counting it here would make the
  // studio's own queue a list of things they cannot act on — which is how a queue stops being
  // read.
  { id: 'new', label: 'Needs triage', states: ['submitted', 'triage'] },
  { id: 'clarifying', label: 'Clarifying', states: ['needs_clarification'] },
  { id: 'accepted', label: 'Accepted', states: ['accepted', 'planned', 'delivered'] },
  { id: 'deferred', label: 'Deferred', states: ['deferred'] },
  { id: 'declined', label: 'Declined', states: ['declined', 'withdrawn'] },
] as const satisfies readonly {
  id: string;
  label: string;
  states: readonly ClientRequestState[];
}[];

export type TriageBucketId = (typeof TRIAGE_BUCKETS)[number]['id'];

export function bucketOf(state: ClientRequestState): TriageBucketId {
  const found = TRIAGE_BUCKETS.find((bucket) =>
    (bucket.states as readonly string[]).includes(state),
  );
  return found?.id ?? 'new';
}

/**
 * How long this has been waiting, in the shortest true unit.
 *
 * The design's inbox has an AGE column with values like "2d" and "4h", and age is the only
 * urgency signal on that screen that is a fact rather than a judgement: nothing in this system
 * ranks importance, so a queue sorted by anything else would be sorting by something invented.
 */
export function describeAge(createdAt: string, now: Date): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return '—';

  const minutes = Math.max(0, Math.floor((now.getTime() - created.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The sentence the client will actually read when this is accepted.
 *
 * The design's `REQ-03 Commitment review` shows it under "WHAT THE CLIENT WILL READ", and this
 * builds it from the same two fields the API will store — the scope summary and the commitment —
 * rather than from a template that could drift from them. A manager sees the client's view of
 * their own decision *before* making it, which is the only point at which seeing it can change
 * anything.
 */
export function previewClientSentence(
  scopeSummary: string,
  commitment: { kind: 'committed'; day: string } | { kind: 'unscheduled' },
): string {
  const scope = scopeSummary.trim() === '' ? '…' : scopeSummary.trim();
  if (commitment.kind === 'unscheduled') {
    return `We have accepted this: ${scope}. We have not committed to a date yet, and you will see one here when we do.`;
  }
  return `We have accepted this and committed to ${formatDay(commitment.day)}: ${scope}.`;
}

/**
 * The gap between what was asked for and what is being promised.
 *
 * The artifact states it in capitals — "10 SEP ≠ THEIR DESIRED 3 SEP · THE DIFFERENCE IS STATED,
 * NOT HIDDEN" — and that is the requirement rather than the decoration. Returns `null` when
 * there is nothing to state: no desired date, no committed date, or the two agree.
 */
export function describeDateGap(
  desiredAt: string | null,
  committedDay: string | null,
): string | null {
  if (desiredAt === null || committedDay === null) return null;

  // Both are 'YYYY-MM-DD' since 0012; pinning both to midnight UTC makes the difference a
  // whole number of days in every zone.
  const desired = new Date(desiredAt.length === 10 ? `${desiredAt}T00:00:00.000Z` : desiredAt);
  const committed = new Date(`${committedDay}T00:00:00.000Z`);
  if (Number.isNaN(desired.getTime()) || Number.isNaN(committed.getTime())) return null;

  const days = Math.round((committed.getTime() - desired.getTime()) / 86_400_000);
  if (days === 0) return null;
  if (days > 0) {
    return `${formatDay(committedDay)} is ${days} day${days === 1 ? '' : 's'} later than the ${formatDay(desiredAt)} they asked for. They will see both.`;
  }
  const earlier = -days;
  return `${formatDay(committedDay)} is ${earlier} day${earlier === 1 ? '' : 's'} earlier than the ${formatDay(desiredAt)} they asked for.`;
}

export function formatDay(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  // UTC, because these are calendar dates pinned to midnight UTC (0012): formatting them in
  // the reader's own zone is what showed every date a day early west of Greenwich.
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(parsed);
}
