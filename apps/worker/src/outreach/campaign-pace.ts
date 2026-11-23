/**
 * LANE-Q — the outreach campaign's pace, as pure functions (owner-approved, EMAIL-DRAFT-v1).
 *
 * - Per mailbox per day: 5 in the campaign's first week, 10 in the second, then 20. Never more
 *   than 20 (MAX_PER_MAILBOX_PER_DAY), whatever the day. "A day" is a rolling 24 hours, counted
 *   from every attempt (sent or refused), so a failing mailbox cannot be hammered either.
 * - Spacing: sends from one mailbox are at least 8 h / cap apart (96 min at 5 a day, 24 min at 20),
 *   and a sweep pass sends at most one mail per mailbox.
 * - Only between 09:00 and 17:00 in the recipient's own time zone (their country's zone).
 *
 * Gradual warm-up and a low per-mailbox ceiling follow the bulk-sender guidance of Google
 * ("Email sender guidelines", support.google.com/a/answer/81126) and Yahoo (Sender Best
 * Practices, senders.yahooinc.com/best-practices): ramp volume slowly on a new sending identity.
 */

export const MAX_PER_MAILBOX_PER_DAY = 20;
export const SEND_WINDOW = { startHour: 9, endHour: 17 } as const;
const DAY_MS = 86_400_000;
const WORKING_SPAN_MS = (SEND_WINDOW.endHour - SEND_WINDOW.startHour) * 3_600_000;

/** The day's cap for one mailbox, from the campaign's first start. */
export function dailyCap(firstStartedAt: Date, now: Date): number {
  const day = Math.max(0, Math.floor((now.getTime() - firstStartedAt.getTime()) / DAY_MS));
  const cap = day < 7 ? 5 : day < 14 ? 10 : 20;
  return Math.min(cap, MAX_PER_MAILBOX_PER_DAY);
}

/** The least time between two sends from one mailbox at this cap. */
export function spacingMs(cap: number): number {
  return Math.ceil(WORKING_SPAN_MS / Math.max(1, cap));
}

/** The local hour (0-23) at `now` in `timeZone`, or `null` for a zone Intl does not know. */
function localHour(now: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    return Number.isFinite(hour) ? hour : null;
  } catch {
    return null;
  }
}

/** True from 09:00 up to (not including) 17:00 local time; never for an unknown zone. */
export function inSendWindow(now: Date, timeZone: string): boolean {
  const hour = localHour(now, timeZone);
  return hour !== null && hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
}

export interface MailboxState {
  /** Attempts from this mailbox in the last 24 hours. */
  readonly attempts24h: number;
  readonly lastAttemptAt: Date | null;
}

/** Whether this mailbox may send one more mail now, at this cap. */
export function mailboxMaySend(state: MailboxState, cap: number, now: Date): boolean {
  if (state.attempts24h >= Math.min(cap, MAX_PER_MAILBOX_PER_DAY)) return false;
  if (state.lastAttemptAt === null) return true;
  return now.getTime() - state.lastAttemptAt.getTime() >= spacingMs(cap);
}

/** A campaign's own pace (OUTREACH MANAGER 0409): its daily cap, and whether it warms up. */
export interface CampaignPace {
  readonly firstStartedAt: Date;
  /** 1-20 per mailbox per day (`outreach_campaigns.daily_cap`). */
  readonly dailyCap: number;
  /** When on, the cap ramps 5 / 10 / then `dailyCap` by campaign week. */
  readonly warmup: boolean;
}

/** The day's cap for one mailbox in this campaign: never above the ramp (if on) nor above 20. */
export function campaignCap(pace: CampaignPace, now: Date): number {
  const own = Math.max(1, Math.min(Math.floor(pace.dailyCap), MAX_PER_MAILBOX_PER_DAY));
  return pace.warmup ? Math.min(dailyCap(pace.firstStartedAt, now), own) : own;
}

/** The calendar date (YYYY-MM-DD) at `at` in `timeZone`, or `null` for an unknown zone. */
function localDate(at: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return null;
  }
}

/**
 * Working days (Monday to Friday) after `from` up to and including `to`, counted on the calendar
 * of `timeZone`. Sent on a Friday, checked the next Tuesday: 2. `null` for an unknown zone.
 */
export function workingDaysBetween(from: Date, to: Date, timeZone: string): number | null {
  const start = localDate(from, timeZone);
  const end = localDate(to, timeZone);
  if (start === null || end === null) return null;
  const day = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  let count = 0;
  // Bounded: a follow-up is at most a few weeks out; past 400 days the answer no longer matters.
  for (let at = day + DAY_MS, i = 0; at <= last && i < 400; at += DAY_MS, i += 1) {
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}
