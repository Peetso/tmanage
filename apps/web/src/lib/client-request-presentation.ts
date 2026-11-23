import type { CapsuleState } from '@tmanage/ui';
import type { ClientRequest, ClientRequestStatus } from './api/portal';
import { appIntlLocale } from './i18n/app-locale';

/**
 * How a client request's status is *said*, in one place.
 *
 * Three surfaces render it — `CL-09`'s confirmation, `CL-10`'s detail, and the request cards
 * on `CL-02` — and law 3 of the token export is that every state using colour also carries a
 * word. If each surface chose its own word, the colour would be the only thing they agreed on,
 * which is the failure the law exists to prevent. `work-item-presentation.ts` does the same job
 * for the internal lifecycle and this is deliberately a **separate** file: the two vocabularies
 * are allowed to diverge, and a shared table is how a client eventually reads `internal_review`.
 *
 * The capsule states are the design system's vocabulary, not §6's. Three of the mappings are
 * judgements rather than transcriptions and are worth naming:
 *
 * - `clarifying` is `client`, not `waiting`. The `client` capsule is the one that means "this
 *   is on you" everywhere else in the portal, and a clarification is the only request status
 *   where the client is the one holding it up.
 * - `deferred` is `future`, not `blocked`. Deferred means "yes, later" — the studio has said
 *   something, and drawing it in the colour of a failure would misreport an answer the client
 *   was actually given.
 * - `declined` is `blocked`, and `withdrawn` is `archived`. Both are endings, and they are drawn
 *   differently because one of them is the studio's decision and the other is the client's.
 */

const STATUS_CAPSULE: Record<ClientRequestStatus, CapsuleState> = {
  submitted: 'neutral',
  clarifying: 'client',
  accepted: 'done',
  deferred: 'future',
  declined: 'blocked',
  planned: 'current',
  delivered: 'done',
  withdrawn: 'archived',
};

/**
 * The word on the capsule.
 *
 * `22-SCREEN-BY-SCREEN` §6 CL-06 names the statuses in the machine's own vocabulary —
 * "submitted/clarifying/accepted/deferred/declined/planned/delivered" — and these are the same
 * seven said the way a person would. "Waiting for your answer" rather than "Clarifying",
 * because a client reading their own portal is not reading a state diagram.
 */
const STATUS_LABEL: Record<ClientRequestStatus, string> = {
  submitted: 'Sent',
  clarifying: 'Waiting for your answer',
  accepted: 'Accepted',
  deferred: 'Not now',
  declined: 'Declined',
  planned: 'Being planned',
  delivered: 'Delivered',
  withdrawn: 'Withdrawn',
};

/**
 * The sentence under the capsule: what this status means for the reader, now.
 *
 * Every one of them says who the request is with, because that is the question a client opens
 * the portal to answer. None of them promises a date — the commitment is a separate field with
 * its own words, and a status line that said "coming soon" would make one on the studio's
 * behalf.
 */
const STATUS_MEANING: Record<ClientRequestStatus, string> = {
  submitted: 'Sent. Nothing is scheduled yet, and nothing is expected from you.',
  clarifying: 'The studio has asked you something. It stays here until you answer.',
  accepted: 'The studio has taken this on. Whether a date is agreed is shown separately.',
  deferred: 'Not being picked up for now. The reason is below, and you can ask again.',
  declined: 'The studio is not taking this on. The reason is below.',
  planned: 'Scheduled, and being worked into the plan.',
  delivered: 'Done and delivered.',
  withdrawn: 'You took this back. Nothing is expected from anybody.',
};

export function requestStatusCapsule(status: ClientRequestStatus): CapsuleState {
  return STATUS_CAPSULE[status] ?? 'neutral';
}

export function requestStatusLabel(status: ClientRequestStatus): string {
  return STATUS_LABEL[status] ?? status;
}

export function requestStatusMeaning(status: ClientRequestStatus): string {
  return STATUS_MEANING[status] ?? '';
}

/**
 * Whether this request is currently the client's to move.
 *
 * `clarifying` is the only status where the studio is waiting on the client, so it is the only
 * one a request card belongs in on `CL-02 My Actions`. Derived here rather than in the screen
 * so the list and the card cannot disagree about which requests are "yours to answer".
 */
export function isWaitingOnClient(request: ClientRequest): boolean {
  return request.status === 'clarifying';
}

/**
 * What the studio has agreed to, in words, and never in the same sentence as the desired date.
 *
 * `23-ERD` §6 gives an acceptance "committed date or explicit unscheduled state", and the three
 * answers below are the three the row can actually hold. The distinction between "no date yet"
 * (nothing agreed) and "accepted, no date" (agreed to do it, not yet scheduled) is the one this
 * function exists to keep: they look the same to a client and mean very different things.
 */
export function describeCommitment(request: ClientRequest): string {
  if (request.commitment === 'committed' && request.committedAt !== null) {
    return `Agreed for ${formatDay(request.committedAt)}`;
  }
  if (request.commitment === 'unscheduled') {
    return 'Agreed to do, no date set yet';
  }
  return 'No date agreed';
}

/**
 * What the client asked for, labelled so it cannot be mistaken for what they were promised.
 *
 * US-B01: "visible acknowledgement that date is requested, not committed". The word "asked for"
 * carries that; "due" or "by" would not.
 */
export function describeDesiredDate(value: string | null): string {
  return value === null ? 'No date asked for' : `Asked for ${formatDay(value)}`;
}

/**
 * Render a calendar date without letting the reader's timezone move it.
 *
 * The values this formats are `'YYYY-MM-DD'` strings from `DATE` columns (0012). They are
 * pinned to midnight UTC and formatted **in UTC**, so 3 September is 3 September in every
 * zone — `new Date(value).toLocaleDateString(appIntlLocale())` on an instant was how the portal showed a
 * client west of UTC the day before the one they picked.
 */
export function formatDay(value: string): string {
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(appIntlLocale(), { dateStyle: 'long', timeZone: 'UTC' }).format(
    parsed,
  );
}
