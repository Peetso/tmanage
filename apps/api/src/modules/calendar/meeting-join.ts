import { randomBytes } from 'node:crypto';

/**
 * 53-12 — the pure rules of the meeting join flow: which call links are allowed, when Join is open,
 * how a Join click turns into attendance, and how a quick room is named. No I/O, no clock of its
 * own (the caller passes `now`), so every rule is unit-tested without a database.
 */

/** Join opens this long before the start ("Join opens 10 minutes before the start"). */
export const JOIN_OPENS_BEFORE_MS = 10 * 60_000;
/** A meeting without an end is treated as an hour long. */
export const DEFAULT_LENGTH_MS = 60 * 60_000;
/** Join stays open this long after the end (a meeting that overruns). */
export const JOIN_CLOSES_AFTER_MS = 60 * 60_000;
/** A person who joins this long after the start is shown as late. */
export const LATE_AFTER_MS = 5 * 60_000;

/** The video hosts a call link may point at. The server never fetches any of them. */
export const MEETING_HOSTS: readonly string[] = [
  'meet.google.com',
  'teams.microsoft.com',
  'teams.live.com',
  'zoom.us',
  'webex.com',
  'whereby.com',
  'meet.jit.si',
];

/** The quick room's host: Jitsi's free public servers (no key, no paid service). */
export const QUICK_ROOM_HOST = 'meet.jit.si';

export type CallProvider = 'google_meet' | 'teams' | 'zoom' | 'webex' | 'whereby' | 'jitsi';

function hostAllowed(host: string): boolean {
  return MEETING_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * The canonical form of a call link, or `null` when it is not one: `https:` only, no user name or
 * password, no port, a host on {@link MEETING_HOSTS} (or a sub-domain of one, e.g. `us02web.zoom.us`),
 * at most 1024 characters. Anything else — `javascript:`, `http:`, an IP address, a look-alike
 * host (`meet.google.com.evil.io`), a URL with credentials — is refused, so the link can never be
 * an open redirect to a phishing page.
 */
export function normaliseCallUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 1024) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!hostAllowed(host)) return null;
  const href = url.toString();
  return href.length <= 1024 ? href : null;
}

/** Which provider a (valid) call link belongs to, for the icon and the button label. */
export function providerOf(url: string): CallProvider {
  const host = new URL(url).hostname.toLowerCase();
  if (host === 'meet.google.com') return 'google_meet';
  if (host.endsWith('zoom.us')) return 'zoom';
  if (host.endsWith('webex.com')) return 'webex';
  if (host.endsWith('whereby.com')) return 'whereby';
  if (host === QUICK_ROOM_HOST) return 'jitsi';
  return 'teams';
}

export type JoinWindowState = 'not_open' | 'open' | 'ended';

export interface JoinWindow {
  readonly state: JoinWindowState;
  readonly opensAt: Date;
  readonly closesAt: Date;
}

/** When Join is open for a meeting: from 10 min before the start to an hour after the end. */
export function joinWindow(startsAt: Date, endsAt: Date | null, now: Date): JoinWindow {
  const opensAt = new Date(startsAt.getTime() - JOIN_OPENS_BEFORE_MS);
  const end = endsAt ?? new Date(startsAt.getTime() + DEFAULT_LENGTH_MS);
  const closesAt = new Date(end.getTime() + JOIN_CLOSES_AFTER_MS);
  const t = now.getTime();
  const state = t < opensAt.getTime() ? 'not_open' : t > closesAt.getTime() ? 'ended' : 'open';
  return { state, opensAt, closesAt };
}

/** The person's existing attendance row, as far as a Join click cares. */
export interface ExistingAttendance {
  readonly firstJoinedAt: Date | null;
}

/**
 * What a Join click inside the window does: the first one inserts the row (joined at = now), every
 * later one only touches it (`last_joined_at`, the count) — attendance is recorded once per join
 * window, so a person who clicks Join five times is one row joined at their first click.
 */
export type AttendancePlan =
  | { readonly kind: 'insert'; readonly joinedAt: Date }
  | { readonly kind: 'touch'; readonly firstJoinedAt: Date; readonly lastJoinedAt: Date };

export function planAttendance(existing: ExistingAttendance | null, now: Date): AttendancePlan {
  if (existing === null) return { kind: 'insert', joinedAt: now };
  // A row the organizer wrote by hand ("Mark absent") has no join time yet: this click is the first.
  return {
    kind: 'touch',
    firstJoinedAt: existing.firstJoinedAt ?? now,
    lastJoinedAt: now,
  };
}

export type AttendanceStatus = 'present' | 'late' | 'absent' | 'expected';

/**
 * How the attendance list shows one person: present, late (joined more than 5 min after the start,
 * with the minutes), absent (marked, or never joined once the meeting ended) or still expected.
 */
export function attendanceStatus(
  row: { readonly status: 'present' | 'absent'; readonly firstJoinedAt: Date | null } | null,
  startsAt: Date,
  window: JoinWindow,
): { readonly status: AttendanceStatus; readonly lateMinutes: number | null } {
  if (row?.status === 'absent') return { status: 'absent', lateMinutes: null };
  if (row?.status === 'present') {
    const late = row.firstJoinedAt ? row.firstJoinedAt.getTime() - startsAt.getTime() : 0;
    return late > LATE_AFTER_MS
      ? { status: 'late', lateMinutes: Math.round(late / 60_000) }
      : { status: 'present', lateMinutes: null };
  }
  return { status: window.state === 'ended' ? 'absent' : 'expected', lateMinutes: null };
}

/** A quick room: a meet.jit.si room with a 128-bit random, unguessable name. */
export function quickRoomUrl(random: (size: number) => Buffer = randomBytes): string {
  return `https://${QUICK_ROOM_HOST}/TManage-${random(16).toString('hex')}`;
}
