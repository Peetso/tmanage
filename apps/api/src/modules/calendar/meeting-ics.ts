/**
 * CAL — ICS export (x128). The pure RFC-5545 serializer for a single meeting.
 *
 * This file holds no tenant, no database and no authorization: it turns an already-resolved,
 * already-authorized meeting into a `text/calendar` document and nothing else. The tenant scope
 * and the relation check happen in {@link MeetingsService.get} before a row ever reaches here
 * (the Known-trap order — resolve tenant-scoped first, a cross-tenant id is a 404, never a 500).
 * Keeping the render pure is what lets a single unit test prove the escaping and the shape without
 * a database.
 *
 * ## What RFC 5545 asks for, and what this does
 *
 * - **CRLF line endings** (§3.1). Every line, including the last, is terminated with `\r\n`.
 * - **TEXT escaping** (§3.3.11) on `SUMMARY`: a backslash becomes `\\`, a semicolon `\;`, a comma
 *   `\,`, and any newline `\n`. A summary a person typed cannot inject a property line or a
 *   parameter this way.
 * - **UTC date-times** (§3.3.5, form 2): `DTSTART`/`DTEND`/`DTSTAMP` are emitted as
 *   `YYYYMMDDTHHMMSSZ`, the unambiguous UTC form, so a reader in any zone places the event at the
 *   same instant.
 * - **Line folding** (§3.1): a content line longer than 75 octets is folded with CRLF + a single
 *   space, so a long summary cannot produce an over-length line a strict parser would reject.
 *
 * The meetings table carries only a start (`meetings.starts_at`), so the caller supplies `endsAt`
 * — the controller derives it from the start plus a fixed default duration and records that
 * decision. `DTSTAMP` is when the document was produced, supplied by the caller so this stays a
 * pure function of its input (no clock read inside).
 */

/** A meeting reduced to exactly the fields an ICS `VEVENT` needs. No tenant id, by construction. */
export interface IcsMeeting {
  /** The `UID` — the meeting's id. A UUID, so no escaping is required, but it is escaped anyway. */
  readonly uid: string;
  /** The `SUMMARY` — the meeting title, escaped per RFC 5545 §3.3.11. */
  readonly summary: string;
  /** `DTSTART`, rendered as a UTC instant. */
  readonly startsAt: Date;
  /** `DTEND`, rendered as a UTC instant. */
  readonly endsAt: Date;
  /** `DTSTAMP` — when the calendar object was produced. */
  readonly stamp: Date;
}

const PRODID = '-//TManage//Calendar//EN';
const MAX_OCTETS = 75;

/** Escape a value for an RFC 5545 TEXT property (§3.3.11). Order matters: backslash first. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Render a `Date` as an RFC 5545 UTC date-time, `YYYYMMDDTHHMMSSZ` (§3.3.5). */
function formatUtc(date: Date): string {
  const iso = date.toISOString(); // 2026-10-01T14:00:00.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(
    14,
    16,
  )}${iso.slice(17, 19)}Z`;
}

/**
 * Fold one content line to at most 75 octets (§3.1). Continuation lines begin with a single
 * space; a fold never splits a UTF-8 multi-byte sequence, so the octet budget is spent per
 * code point rather than mid-character.
 */
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= MAX_OCTETS) return line;

  const parts: string[] = [];
  let current = '';
  let currentOctets = 0;
  let limit = MAX_OCTETS; // the first line has no leading space; continuations spend one octet on it
  for (const char of line) {
    const charOctets = encoder.encode(char).length;
    if (currentOctets + charOctets > limit) {
      parts.push(current);
      current = char;
      currentOctets = charOctets;
      limit = MAX_OCTETS - 1; // continuation lines carry a leading space
    } else {
      current += char;
      currentOctets += charOctets;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/**
 * 53-14. One event of a multi-event feed: a timed meeting, or an all-day entry (a due date) on a
 * `YYYY-MM-DD` date. `url` and `description` are optional and escaped like `SUMMARY`.
 */
export type IcsEvent =
  | (Omit<IcsMeeting, 'stamp'> & {
      readonly kind?: 'timed';
      readonly description?: string;
      readonly url?: string;
    })
  | {
      readonly kind: 'all_day';
      readonly uid: string;
      readonly summary: string;
      readonly date: string;
      readonly description?: string;
      readonly url?: string;
    };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(date: string): string {
  return date.replace(/-/g, '');
}

function nextDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function eventLines(event: IcsEvent, stamp: Date): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${escapeText(event.uid)}`, `DTSTAMP:${formatUtc(stamp)}`];
  if (event.kind === 'all_day') {
    if (!DATE_ONLY.test(event.date)) return [];
    lines.push(
      `DTSTART;VALUE=DATE:${formatDate(event.date)}`,
      `DTEND;VALUE=DATE:${formatDate(nextDate(event.date))}`,
      'TRANSP:TRANSPARENT',
    );
  } else {
    lines.push(`DTSTART:${formatUtc(event.startsAt)}`, `DTEND:${formatUtc(event.endsAt)}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  // A URI value is not TEXT: only an http(s) address with no control characters is written.
  if (event.url && /^https?:\/\/[^\s"<>]+$/.test(event.url)) lines.push(`URL:${event.url}`);
  lines.push('END:VEVENT');
  return lines;
}

/**
 * 53-14. A whole read-only calendar (a person's ICS feed): every event, one `VCALENDAR`, with a
 * display name. Pure, like {@link serializeMeetingIcs}.
 */
export function serializeCalendarIcs(input: {
  readonly name: string;
  readonly events: readonly IcsEvent[];
  readonly stamp: Date;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(input.name)}`,
    ...input.events.flatMap((event) => eventLines(event, input.stamp)),
    'END:VCALENDAR',
  ];
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/**
 * Serialize one meeting to a complete `text/calendar` document (a `VCALENDAR` with a single
 * `VEVENT`). Read-only by construction: it takes a value object and returns a string, mutating
 * nothing.
 */
export function serializeMeetingIcs(meeting: IcsMeeting): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...eventLines(meeting, meeting.stamp),
    'END:VCALENDAR',
  ];
  // A trailing CRLF terminates the final line too, as §3.1 requires.
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
