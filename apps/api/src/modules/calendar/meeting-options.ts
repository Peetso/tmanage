/**
 * 0237. The event options a meeting carries — every option a Google Calendar event offers that
 * TManage edits — with their vocabularies and the one parser the controller uses for both POST
 * and PATCH. Pure: no database, no network.
 */

export const MEETING_VISIBILITIES = ['default', 'public', 'private', 'confidential'] as const;
export const MEETING_SHOW_AS = ['busy', 'free'] as const;
export const MEETING_CONFERENCES = ['none', 'google_meet', 'teams'] as const;
export const REMINDER_METHODS = ['popup', 'email'] as const;
/** Google's event colours are `1`..`11`. */
export const MEETING_COLOR_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'] as const;

export type MeetingVisibility = (typeof MEETING_VISIBILITIES)[number];
export type MeetingShowAs = (typeof MEETING_SHOW_AS)[number];
export type MeetingConference = (typeof MEETING_CONFERENCES)[number];
export type ReminderMethod = (typeof REMINDER_METHODS)[number];

export interface MeetingReminder {
  readonly method: ReminderMethod;
  /** Minutes before the start, 0 to 40320 (four weeks, Google's limit). */
  readonly minutes: number;
}

export const MAX_REMINDERS = 5;
const MAX_REMINDER_MINUTES = 40_320;
const MAX_LOCATION_LENGTH = 512;
const MAX_RRULE_LENGTH = 1024;

/** The options as the repository stores them. `undefined` = leave alone (PATCH). */
export interface MeetingOptionsInput {
  readonly allDay?: boolean;
  readonly timeZone?: string | null;
  readonly location?: string | null;
  readonly recurrenceRrule?: string | null;
  readonly visibility?: MeetingVisibility;
  readonly showAs?: MeetingShowAs;
  readonly colorId?: string | null;
  readonly conference?: MeetingConference;
  readonly reminders?: readonly MeetingReminder[] | null;
  readonly guestsCanModify?: boolean;
  readonly guestsCanInviteOthers?: boolean;
  readonly guestsCanSeeOthers?: boolean;
}

/** `popup:10,email:1440` — the column's compact form. */
export function formatReminders(reminders: readonly MeetingReminder[] | null): string | null {
  if (reminders === null) return null;
  return reminders.map((r) => `${r.method}:${r.minutes}`).join(',');
}

/** The column back to a list; anything malformed is dropped rather than trusted. */
export function parseReminders(raw: string | null): readonly MeetingReminder[] | null {
  if (raw === null) return null;
  if (raw === '') return [];
  const out: MeetingReminder[] = [];
  for (const part of raw.split(',').slice(0, MAX_REMINDERS)) {
    const [method, minutes] = part.split(':');
    const value = Number(minutes);
    if ((REMINDER_METHODS as readonly string[]).includes(method ?? '') && Number.isInteger(value)) {
      out.push({ method: method as ReminderMethod, minutes: value });
    }
  }
  return out;
}

/** An IANA zone name the runtime knows (`Intl` refuses an unknown one). */
export function isTimeZone(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

const RRULE_PART = /^(FREQ|INTERVAL|COUNT|UNTIL|BYDAY|BYMONTHDAY|BYMONTH|WKST)=[A-Z0-9,+-]+$/;
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/**
 * An RFC 5545 RRULE body (no `RRULE:` prefix) limited to what both Google and the Outlook converter
 * (slice B) understand: FREQ daily/weekly/monthly/yearly, INTERVAL, COUNT or UNTIL, BYDAY,
 * BYMONTHDAY, BYMONTH, WKST. Anything else is refused at validation, never sent half-understood.
 */
export function isSupportedRrule(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RRULE_LENGTH) return false;
  const parts = raw.split(';');
  const keys = new Set<string>();
  for (const part of parts) {
    if (!RRULE_PART.test(part)) return false;
    const key = part.split('=')[0] as string;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  const freq = parts.find((p) => p.startsWith('FREQ='))?.slice(5);
  if (!freq || !FREQS.includes(freq)) return false;
  return !(keys.has('COUNT') && keys.has('UNTIL'));
}

type Details = { field: string; message: string }[];

function bool(raw: unknown, field: string, details: Details): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'boolean') {
    details.push({ field, message: 'must be true or false' });
    return undefined;
  }
  return raw;
}

function oneOf<T extends string>(
  raw: unknown,
  values: readonly T[],
  field: string,
  details: Details,
): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
    details.push({ field, message: `must be one of ${values.join(', ')}` });
    return undefined;
  }
  return raw as T;
}

function nullableText(
  raw: unknown,
  field: string,
  max: number,
  details: Details,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > max) {
    details.push({ field, message: `must be a string of at most ${max} characters, or null` });
    return undefined;
  }
  return raw.trim() === '' ? null : raw.trim();
}

/** Every option field of a POST or PATCH body; errors are added to `details`. */
export function parseMeetingOptions(
  body: Record<string, unknown> | null | undefined,
  details: Details,
): MeetingOptionsInput {
  const b = body ?? {};
  const out: { -readonly [K in keyof MeetingOptionsInput]: MeetingOptionsInput[K] } = {};

  const allDay = bool(b['allDay'], 'allDay', details);
  if (allDay !== undefined) out.allDay = allDay;

  if (b['timeZone'] !== undefined) {
    if (b['timeZone'] === null || b['timeZone'] === '') out.timeZone = null;
    else if (isTimeZone(b['timeZone'])) out.timeZone = b['timeZone'];
    else details.push({ field: 'timeZone', message: 'must be an IANA time zone, or null' });
  }

  const location = nullableText(b['location'], 'location', MAX_LOCATION_LENGTH, details);
  if (location !== undefined) out.location = location;

  if (b['rrule'] !== undefined) {
    if (b['rrule'] === null || b['rrule'] === '') out.recurrenceRrule = null;
    else {
      const raw = typeof b['rrule'] === 'string' ? b['rrule'].replace(/^RRULE:/i, '') : b['rrule'];
      if (isSupportedRrule(raw)) out.recurrenceRrule = raw;
      else {
        details.push({
          field: 'rrule',
          message: 'must be an RRULE with FREQ daily/weekly/monthly/yearly (or null)',
        });
      }
    }
  }

  const visibility = oneOf(b['visibility'], MEETING_VISIBILITIES, 'visibility', details);
  if (visibility !== undefined) out.visibility = visibility;
  const showAs = oneOf(b['showAs'], MEETING_SHOW_AS, 'showAs', details);
  if (showAs !== undefined) out.showAs = showAs;
  const conference = oneOf(b['conference'], MEETING_CONFERENCES, 'conference', details);
  if (conference !== undefined) out.conference = conference;

  if (b['colorId'] !== undefined) {
    if (b['colorId'] === null || b['colorId'] === '') out.colorId = null;
    else {
      const color = oneOf(b['colorId'], MEETING_COLOR_IDS, 'colorId', details);
      if (color !== undefined) out.colorId = color;
    }
  }

  if (b['reminders'] !== undefined) {
    const raw = b['reminders'];
    if (raw === null) out.reminders = null;
    else if (
      Array.isArray(raw) &&
      raw.length <= MAX_REMINDERS &&
      raw.every(
        (r) =>
          typeof r === 'object' &&
          r !== null &&
          (REMINDER_METHODS as readonly string[]).includes(
            (r as { method?: unknown }).method as string,
          ) &&
          Number.isInteger((r as { minutes?: unknown }).minutes) &&
          ((r as { minutes: number }).minutes ?? -1) >= 0 &&
          (r as { minutes: number }).minutes <= MAX_REMINDER_MINUTES,
      )
    ) {
      out.reminders = (raw as MeetingReminder[]).map((r) => ({
        method: r.method,
        minutes: r.minutes,
      }));
    } else {
      details.push({
        field: 'reminders',
        message: `must be at most ${MAX_REMINDERS} of {method: popup|email, minutes: 0..${MAX_REMINDER_MINUTES}}, or null`,
      });
    }
  }

  const modify = bool(b['guestsCanModify'], 'guestsCanModify', details);
  if (modify !== undefined) out.guestsCanModify = modify;
  const invite = bool(b['guestsCanInviteOthers'], 'guestsCanInviteOthers', details);
  if (invite !== undefined) out.guestsCanInviteOthers = invite;
  const see = bool(b['guestsCanSeeOthers'], 'guestsCanSeeOthers', details);
  if (see !== undefined) out.guestsCanSeeOthers = see;

  return out;
}

export function hasAnyOption(options: MeetingOptionsInput): boolean {
  return Object.values(options).some((value) => value !== undefined);
}

/** A plain email address (lower-cased), or `null`. Deliberately simple; the provider re-checks. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(email)) {
    return null;
  }
  return email;
}
