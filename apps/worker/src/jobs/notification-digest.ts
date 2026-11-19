import type { DigestEmailFacts, DigestMailer } from '../notifications/digest-mailer.js';

/**
 * 53-15 — the notification digest sweep: "one daily e-mail instead of twenty".
 *
 * Every {@link DIGEST_INTERVAL_MS} the sweep lists active internal members with their digest cadence
 * (`pref_digest`; absent = daily at 08:00, the shipped default) and the zone they live in (their
 * quiet-hours zone, else the company's default zone, else UTC). A member is **due** when it is their
 * send hour in their zone (and their weekday, for weekly). For a due member the store, in one
 * transaction, reads their unread inbox rows of the window, keeps the ones whose type is digestable
 * and whose matrix cell has Digest on (`belongsInDigest`), and — only when something is left —
 * claims the window by writing one `notification.digest_sent` inbox row whose dedupe key names the
 * window. The unique dedupe key is the idempotency: the sweep runs four times in the hour and on two
 * workers, and only the first claim of a window sends. No new table (no migration).
 *
 * The mail names counts per kind and links the inbox; it never quotes content. A member whose
 * mail toggle is off, or who has nothing unread, gets nothing.
 *
 * 62-A1c (B12): a member who switched on the business briefing (`pref_digest`, off by default) and
 * whose company has `business_briefing` on also gets the Home card's briefing as one section, read
 * with the card's scope rules (`briefing-store.ts`). The window is claimed when the counts or the
 * briefing have something to say; with both empty nothing is claimed and nothing is sent.
 */

export const DIGEST_INTERVAL_MS = 15 * 60_000;
export const DIGEST_PASS_LIMIT = 2000;
export const DIGEST_SENT_TYPE = 'notification.digest_sent';
const DAY_MS = 24 * 60 * 60_000;

export type DigestCadenceValue = 'immediate' | 'daily' | 'weekly';

export interface DigestRecipient {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly cadence: DigestCadenceValue;
  readonly sendHour: number;
  /** 0 = Sunday … 6 = Saturday; read for `weekly` only. */
  readonly dayOfWeek: number;
  readonly timezone: string;
  /** 62-A1c: add the business briefing section (off by default). */
  readonly businessBriefing: boolean;
}

export interface DigestWindow {
  /** Unread rows created at or after this instant are summarised. */
  readonly since: Date;
  /** The dedupe key of the claim row: one send per member per window. */
  readonly key: string;
  readonly cadence: 'daily' | 'weekly';
  /** The sweep's clock (bound into the store's reads; the database clock is never used). */
  readonly at: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The wall-clock parts of `now` in `timezone` (UTC when the zone is unknown). */
export function localParts(
  now: Date,
  timezone: string,
): { readonly date: string; readonly hour: number; readonly weekday: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    }).formatToParts(now);
  } catch {
    return localParts(now, 'UTC');
  }
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')) % 24,
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** Pure: the window to send now for this member, or null when they are not due. */
export function digestWindowFor(now: Date, recipient: DigestRecipient): DigestWindow | null {
  if (recipient.cadence === 'immediate') return null;
  const local = localParts(now, recipient.timezone);
  if (local.hour !== recipient.sendHour) return null;
  if (recipient.cadence === 'weekly' && local.weekday !== recipient.dayOfWeek) return null;
  const days = recipient.cadence === 'weekly' ? 7 : 1;
  return {
    since: new Date(now.getTime() - days * DAY_MS),
    key: `digest:${recipient.cadence}:${local.date}`,
    cadence: recipient.cadence,
    at: now,
  };
}

export interface NotificationDigestStore {
  listRecipients(limit: number): Promise<readonly DigestRecipient[]>;
  /**
   * In one transaction: collect the member's digestable unread rows since `window.since` and,
   * when switched on, their business briefing; when either has something, claim the window.
   * Returns the mail facts (links resolved through `links`) when this call claimed it, else null.
   */
  collectAndClaim(
    recipient: DigestRecipient,
    window: DigestWindow,
    links: (path: string) => string,
  ): Promise<DigestEmailFacts | null>;
}

export interface DigestSweepResult {
  readonly recipients: number;
  readonly due: number;
  readonly sent: number;
  readonly failed: number;
}

export async function sweepNotificationDigests(
  store: NotificationDigestStore,
  mailer: DigestMailer,
  now: Date = new Date(),
  onError: (error: unknown) => void = () => undefined,
): Promise<DigestSweepResult> {
  if (!mailer.enabled) return { recipients: 0, due: 0, sent: 0, failed: 0 };
  const recipients = await store.listRecipients(DIGEST_PASS_LIMIT);
  let due = 0;
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const window = digestWindowFor(now, recipient);
    if (window === null) continue;
    due += 1;
    try {
      const facts = await store.collectAndClaim(recipient, window, (path) => mailer.linkTo(path));
      if (facts === null) continue;
      if (
        (await mailer.deliver({ ...facts, organizationId: recipient.organizationId })) === 'sent'
      ) {
        sent += 1;
      }
    } catch (error) {
      failed += 1;
      onError(error);
    }
  }
  return { recipients: recipients.length, due, sent, failed };
}

/** Loop mode: one sweep every {@link DIGEST_INTERVAL_MS} until `signal` aborts. */
export async function runNotificationDigestLoop(
  store: NotificationDigestStore,
  mailer: DigestMailer,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await sweepNotificationDigests(store, mailer, new Date(), (error) =>
        console.error('[worker] notification digest: one member failed', error),
      );
    } catch (error) {
      console.error('[worker] notification digest sweep failed', error);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DIGEST_INTERVAL_MS);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
