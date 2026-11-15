import type { SupportThread } from './api/support';

/**
 * 57-10 · how a support request's SLA clock reads on screen ("Get help" and the platform inbox).
 * The API computes the clock (business minutes, pauses, breach); this file only decides which of
 * its facts to show and how to word a business-minute duration. One business day is nine hours
 * (Sun–Thu, 09:00–18:00), matching the policy in `apps/api/src/modules/support/support-sla.ts`.
 */

export const BUSINESS_DAY_MINUTES = 9 * 60;
/** The policy's "same business day" first-response target (Studio). */
const SAME_DAY_MINUTES = 6 * 60;
/** A reply due within this many business minutes is flagged as due soon. */
export const DUE_SOON_MINUTES = 120;

export type SlaSummary =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'answered';
      readonly minutes: number;
      readonly respondedAt: string;
      readonly late: boolean;
    }
  | { readonly kind: 'late'; readonly minutes: number }
  | { readonly kind: 'closed' }
  | {
      readonly kind: 'due';
      readonly minutes: number;
      readonly dueAt: string;
      readonly soon: boolean;
    };

/** The first-response promise: answered, late, still due, or no clock to show. */
export function slaSummary(thread: Pick<SupportThread, 'sla' | 'status'>): SlaSummary {
  const clock = thread.sla;
  if (clock === null) return { kind: 'none' };
  const first = clock.firstResponse;
  if (first.respondedAt !== null) {
    return {
      kind: 'answered',
      minutes: first.elapsedMinutes,
      respondedAt: first.respondedAt,
      late: first.breached,
    };
  }
  if (first.breached) {
    return { kind: 'late', minutes: Math.max(0, first.elapsedMinutes - first.targetMinutes) };
  }
  if (thread.status === 'closed') return { kind: 'closed' };
  const left = Math.max(0, first.targetMinutes - first.elapsedMinutes);
  return { kind: 'due', minutes: left, dueAt: first.dueAt, soon: left <= DUE_SOON_MINUTES };
}

export interface DurationUnits {
  readonly day: string;
  readonly days: string;
  readonly hour: string;
  readonly minute: string;
}

/** "25 min", "2 h 15 min", "1 h 05 min", "1 day 4 h" — in business time. */
export function formatBusinessDuration(total: number, units: DurationUnits): string {
  const minutes = Math.max(0, Math.round(total));
  const days = Math.floor(minutes / BUSINESS_DAY_MINUTES);
  const hours = Math.floor((minutes % BUSINESS_DAY_MINUTES) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    const head = `${days} ${days === 1 ? units.day : units.days}`;
    return hours > 0 ? `${head} ${hours} ${units.hour}` : head;
  }
  if (hours > 0) {
    return rest > 0
      ? `${hours} ${units.hour} ${String(rest).padStart(2, '0')} ${units.minute}`
      : `${hours} ${units.hour}`;
  }
  return `${rest} ${units.minute}`;
}

export type TargetWording =
  | { readonly kind: 'sameDay' }
  | { readonly kind: 'days'; readonly count: number }
  | { readonly kind: 'hours'; readonly count: number };

/** A first-response target as the plans table words it: "4 business hours", "Same business day". */
export function targetWording(minutes: number): TargetWording {
  if (minutes === SAME_DAY_MINUTES) return { kind: 'sameDay' };
  if (minutes >= BUSINESS_DAY_MINUTES && minutes % BUSINESS_DAY_MINUTES === 0) {
    return { kind: 'days', count: minutes / BUSINESS_DAY_MINUTES };
  }
  return { kind: 'hours', count: Math.max(1, Math.round(minutes / 60)) };
}

/** Where a request stands, for its badge (member and platform word it differently). */
export type RequestState =
  'resolved' | 'withCustomer' | 'late' | 'awaitingReply' | 'newReply' | 'answered';

export function requestState(
  thread: Pick<SupportThread, 'sla' | 'status' | 'lastAuthorKind'>,
): RequestState {
  if (thread.status === 'closed') return 'resolved';
  if (thread.status === 'waiting') return 'withCustomer';
  const summary = slaSummary(thread);
  if (summary.kind === 'late') return 'late';
  if (summary.kind === 'due') return 'awaitingReply';
  if (thread.lastAuthorKind === 'member')
    return summary.kind === 'answered' ? 'newReply' : 'awaitingReply';
  return 'answered';
}

export type BadgeTone = 'late' | 'due' | 'answered' | 'neutral';

export const REQUEST_STATE_TONE: Readonly<Record<RequestState, BadgeTone>> = {
  resolved: 'neutral',
  withCustomer: 'neutral',
  late: 'late',
  awaitingReply: 'due',
  newReply: 'due',
  answered: 'answered',
};

/** The platform inbox's quick filters (Figma 614:35191). `late` is also asked of the API. */
export type InboxChip = 'all' | 'open' | 'dueSoon' | 'late' | 'answeredToday';

export function matchesChip(
  thread: Pick<SupportThread, 'sla' | 'status'>,
  chip: InboxChip,
  isToday: (iso: string) => boolean,
): boolean {
  const summary = slaSummary(thread);
  switch (chip) {
    case 'all':
      return true;
    case 'open':
      return thread.status !== 'closed';
    case 'dueSoon':
      return summary.kind === 'due' && summary.soon;
    case 'late':
      return thread.sla?.breached === true;
    case 'answeredToday':
      return summary.kind === 'answered' && isToday(summary.respondedAt);
  }
}

/** The request to answer next: the latest-overdue first, then the least time left. */
export function nextDue<T extends Pick<SupportThread, 'sla' | 'status'>>(
  threads: readonly T[],
): T | null {
  const urgency = (thread: T): number | null => {
    const summary = slaSummary(thread);
    if (summary.kind === 'late') return -summary.minutes;
    if (summary.kind === 'due') return summary.minutes;
    return null;
  };
  let best: { thread: T; score: number } | null = null;
  for (const thread of threads) {
    const score = urgency(thread);
    if (score !== null && (best === null || score < best.score)) best = { thread, score };
  }
  return best?.thread ?? null;
}
