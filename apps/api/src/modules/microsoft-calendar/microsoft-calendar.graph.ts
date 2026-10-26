import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';
import type { StoredAttendeeRsvp } from '../calendar/meeting-attendees.repository.js';
import type { MeetingSnapshot } from '../google-calendar/google-calendar.google.js';
import { dateIn } from '../google-calendar/google-calendar.google.js';
import {
  authorizeEndpoint,
  oneDriveConfigFrom,
  tokenEndpoint,
  type OneDriveConfig,
} from '../onedrive/onedrive.graph.js';

/**
 * Outlook calendar + Teams meetings (0237, slice B) — the protocol half (Microsoft identity
 * platform and Graph). Nothing here touches the database. The Google twin is
 * `google-calendar.google.ts`.
 *
 * - **Configuration** is the OneDrive app registration (`MICROSOFT_CLIENT_ID/SECRET`, optional
 *   `MICROSOFT_TENANT`), read by importing the OneDrive reader, never by copying it.
 * - **Scopes** `openid profile email offline_access Calendars.ReadWrite`. Not
 *   `OnlineMeetings.ReadWrite`: `POST /me/events {isOnlineMeeting: true}` returns the Teams
 *   `onlineMeeting.joinUrl` under Calendars.ReadWrite alone.
 * - **Refresh tokens rotate**: every refresh may answer with a new one, which the caller stores.
 * - **The flow cookie** carries `state` and the PKCE verifier, signed with `SESSION_SECRET` under
 *   its own purpose and bound to the organization and the person who started it.
 * - **Recurrence** is the meeting's RFC 5545 RRULE, converted to Graph's `pattern`/`range` by
 *   {@link toGraphRecurrence}; a rule Graph cannot express is refused (`null`), never half-sent.
 */

export const MSCAL_SCOPES = 'openid profile email offline_access Calendars.ReadWrite';
export const MSCAL_GRAPH = 'https://graph.microsoft.com/v1.0';
export const MSCAL_CALLBACK_PATH = '/v1/integrations/microsoft-calendar/callback';
export const MSCAL_COOKIE_PATH = '/v1';
export const MSCAL_FLOW_COOKIE = 'tm_mscal_flow';
export const MSCAL_FLOW_TTL_SECONDS = 600;
const FLOW_PURPOSE = 'mscal-flow.v1';
/** Every Microsoft call gives up after this long (push runs inside a request). */
export const MSCAL_TIMEOUT_MS = 10_000;

export type MicrosoftCalendarConfig = OneDriveConfig;

/** The Microsoft client from the environment (the OneDrive registration), or `null` (off). */
export function microsoftCalendarConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): MicrosoftCalendarConfig | null {
  return oneDriveConfigFrom(env);
}

// ── The flow cookie ──────────────────────────────────────────────────────────

export interface MicrosoftCalendarFlow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly state: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function newMicrosoftCalendarFlow(
  owner: { organizationId: string; organizationSlug: string; userId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): MicrosoftCalendarFlow {
  return {
    ...owner,
    state: random(),
    verifier: random(),
    expiresAt: nowSeconds + MSCAL_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealMicrosoftCalendarFlow(flow: MicrosoftCalendarFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The flow, or `undefined` for a missing, forged, malformed or expired cookie. */
export function openMicrosoftCalendarFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): MicrosoftCalendarFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  try {
    const flow = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as MicrosoftCalendarFlow;
    const strings = [
      flow.state,
      flow.verifier,
      flow.organizationId,
      flow.organizationSlug,
      flow.userId,
    ];
    if (strings.some((s) => typeof s !== 'string') || typeof flow.expiresAt !== 'number') {
      return undefined;
    }
    return flow.expiresAt < nowSeconds ? undefined : flow;
  } catch {
    return undefined;
  }
}

export function microsoftCalendarStateMatches(
  flow: MicrosoftCalendarFlow,
  returned: unknown,
): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

export function microsoftCalendarAuthorizationUrl(input: {
  config: MicrosoftCalendarConfig;
  redirectUri: string;
  flow: MicrosoftCalendarFlow;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    response_mode: 'query',
    client_id: input.config.clientId,
    redirect_uri: input.redirectUri,
    scope: MSCAL_SCOPES,
    state: input.flow.state,
    code_challenge: createHash('sha256').update(input.flow.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    // A person may hold several Microsoft accounts; let them pick the calendar's one.
    prompt: 'select_account',
  });
  return `${authorizeEndpoint(input.config)}?${params.toString()}`;
}

// ── RRULE <-> Graph recurrence ───────────────────────────────────────────────

const WEEKDAYS = {
  SU: 'sunday',
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
} as const;
type IcalDay = keyof typeof WEEKDAYS;
const INDEXES: Record<string, string> = {
  '1': 'first',
  '2': 'second',
  '3': 'third',
  '4': 'fourth',
  '-1': 'last',
};

export interface GraphRecurrence {
  readonly pattern: {
    readonly type:
      | 'daily'
      | 'weekly'
      | 'absoluteMonthly'
      | 'relativeMonthly'
      | 'absoluteYearly'
      | 'relativeYearly';
    readonly interval: number;
    readonly daysOfWeek?: readonly string[];
    readonly dayOfMonth?: number;
    readonly month?: number;
    readonly index?: string;
    readonly firstDayOfWeek?: string;
  };
  readonly range: {
    readonly type: 'endDate' | 'noEnd' | 'numbered';
    readonly startDate: string;
    readonly endDate?: string;
    readonly numberOfOccurrences?: number;
    readonly recurrenceTimeZone?: string;
  };
}

function rruleParts(rrule: string): Map<string, string> | null {
  const parts = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/i, '').split(';')) {
    const [key, value, extra] = part.split('=');
    if (!key || value === undefined || value === '' || extra !== undefined) return null;
    if (parts.has(key)) return null;
    parts.set(key.toUpperCase(), value.toUpperCase());
  }
  return parts;
}

/** `20271231` or `20271231T235959Z` -> the calendar date in `timeZone`. */
function untilDate(raw: string, timeZone: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(raw);
  if (!m) return null;
  if (!m[4] || !m[7]) return `${m[1]}-${m[2]}-${m[3]}`;
  const instant = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`);
  return Number.isNaN(instant.getTime()) ? null : dateIn(instant, timeZone);
}

/**
 * The meeting's RRULE as Graph's recurrence, anchored on the meeting's first day in its zone, or
 * `null` when Graph has no way to say it (several month days, mixed ordinals, BYSETPOS, …).
 */
export function toGraphRecurrence(
  rrule: string,
  startsAt: Date,
  timeZone: string | null,
): GraphRecurrence | null {
  const zone = timeZone ?? 'UTC';
  const parts = rruleParts(rrule);
  if (!parts) return null;
  const known = new Set([
    'FREQ',
    'INTERVAL',
    'COUNT',
    'UNTIL',
    'BYDAY',
    'BYMONTHDAY',
    'BYMONTH',
    'WKST',
  ]);
  if ([...parts.keys()].some((k) => !known.has(k))) return null;
  const freq = parts.get('FREQ');
  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) return null;
  const startDate = dateIn(startsAt, zone);
  const [, startMonth, startDay] = startDate.split('-').map(Number) as [number, number, number];

  // BYDAY: plain days (`MO,WE`) or one shared ordinal (`2TU`, `-1FR,-1SA`).
  let days: string[] | null = null;
  let ordinal: string | null = null;
  const byDay = parts.get('BYDAY');
  if (byDay !== undefined) {
    days = [];
    const ordinals = new Set<string>();
    for (const entry of byDay.split(',')) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(entry);
      if (!m) return null;
      ordinals.add((m[1] ?? '').replace(/^\+/, ''));
      days.push(WEEKDAYS[m[2] as IcalDay]);
    }
    if (ordinals.size !== 1) return null;
    const only = [...ordinals][0] as string;
    if (only !== '') {
      ordinal = INDEXES[only] ?? null;
      if (!ordinal) return null;
    }
  }
  const monthDay = parts.get('BYMONTHDAY');
  const dayOfMonth = monthDay === undefined ? null : Number(monthDay);
  if (dayOfMonth !== null && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31))
    return null;
  const byMonth = parts.get('BYMONTH');
  const month = byMonth === undefined ? null : Number(byMonth);
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) return null;
  const wkst = parts.get('WKST');
  const firstDayOfWeek = wkst ? WEEKDAYS[wkst as IcalDay] : 'monday';
  if (!firstDayOfWeek) return null;

  let pattern: GraphRecurrence['pattern'];
  switch (freq) {
    case 'DAILY':
      if (dayOfMonth !== null || month !== null || ordinal) return null;
      // FREQ=DAILY;BYDAY=MO,TU,… (interval 1) is Outlook's "every weekday": a weekly pattern.
      if (days) {
        if (interval !== 1) return null;
        pattern = { type: 'weekly', interval: 1, daysOfWeek: days, firstDayOfWeek };
      } else pattern = { type: 'daily', interval };
      break;
    case 'WEEKLY': {
      if (dayOfMonth !== null || month !== null || ordinal) return null;
      const startWeekday = new Date(`${startDate}T12:00:00.000Z`).getUTCDay();
      const fallback = Object.values(WEEKDAYS)[startWeekday] as string;
      pattern = { type: 'weekly', interval, daysOfWeek: days ?? [fallback], firstDayOfWeek };
      break;
    }
    case 'MONTHLY':
      if (month !== null) return null;
      if (days) {
        if (!ordinal || dayOfMonth !== null) return null;
        pattern = { type: 'relativeMonthly', interval, daysOfWeek: days, index: ordinal };
      } else {
        pattern = { type: 'absoluteMonthly', interval, dayOfMonth: dayOfMonth ?? startDay };
      }
      break;
    case 'YEARLY':
      if (days) {
        if (!ordinal || dayOfMonth !== null) return null;
        pattern = {
          type: 'relativeYearly',
          interval,
          daysOfWeek: days,
          index: ordinal,
          month: month ?? startMonth,
        };
      } else {
        pattern = {
          type: 'absoluteYearly',
          interval,
          dayOfMonth: dayOfMonth ?? startDay,
          month: month ?? startMonth,
        };
      }
      break;
    default:
      return null;
  }

  let range: GraphRecurrence['range'];
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count !== undefined && until !== undefined) return null;
  if (count !== undefined) {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 999) return null;
    range = { type: 'numbered', startDate, numberOfOccurrences: n, recurrenceTimeZone: zone };
  } else if (until !== undefined) {
    const endDate = untilDate(until, zone);
    if (!endDate || endDate < startDate) return null;
    range = { type: 'endDate', startDate, endDate, recurrenceTimeZone: zone };
  } else {
    range = { type: 'noEnd', startDate, recurrenceTimeZone: zone };
  }
  return { pattern, range };
}

const ICAL_DAYS = Object.fromEntries(Object.entries(WEEKDAYS).map(([k, v]) => [v, k])) as Record<
  string,
  IcalDay
>;
const ORDINALS = Object.fromEntries(Object.entries(INDEXES).map(([k, v]) => [v, k])) as Record<
  string,
  string
>;

/** Graph's recurrence back to an RRULE body (no `RRULE:` prefix), or `null` when unreadable. */
export function fromGraphRecurrence(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { pattern, range } = raw as {
    pattern?: Record<string, unknown>;
    range?: Record<string, unknown>;
  };
  if (!pattern || !range) return null;
  const interval = typeof pattern['interval'] === 'number' ? pattern['interval'] : 1;
  const days = Array.isArray(pattern['daysOfWeek'])
    ? (pattern['daysOfWeek'] as unknown[]).map((d) => ICAL_DAYS[String(d).toLowerCase()])
    : [];
  if (days.some((d) => d === undefined)) return null;
  const index = ORDINALS[String(pattern['index'] ?? 'first')] ?? '1';
  const out: string[] = [];
  switch (pattern['type']) {
    case 'daily':
      out.push('FREQ=DAILY');
      break;
    case 'weekly':
      out.push('FREQ=WEEKLY');
      if (days.length > 0) out.push(`BYDAY=${days.join(',')}`);
      break;
    case 'absoluteMonthly':
      out.push('FREQ=MONTHLY', `BYMONTHDAY=${Number(pattern['dayOfMonth'])}`);
      break;
    case 'relativeMonthly':
      if (days.length === 0) return null;
      out.push('FREQ=MONTHLY', `BYDAY=${days.map((d) => `${index}${d}`).join(',')}`);
      break;
    case 'absoluteYearly':
      out.push(
        'FREQ=YEARLY',
        `BYMONTH=${Number(pattern['month'])}`,
        `BYMONTHDAY=${Number(pattern['dayOfMonth'])}`,
      );
      break;
    case 'relativeYearly':
      if (days.length === 0) return null;
      out.push(
        'FREQ=YEARLY',
        `BYMONTH=${Number(pattern['month'])}`,
        `BYDAY=${days.map((d) => `${index}${d}`).join(',')}`,
      );
      break;
    default:
      return null;
  }
  if (interval !== 1) out.splice(1, 0, `INTERVAL=${interval}`);
  if (range['type'] === 'numbered' && typeof range['numberOfOccurrences'] === 'number') {
    out.push(`COUNT=${range['numberOfOccurrences']}`);
  } else if (range['type'] === 'endDate' && typeof range['endDate'] === 'string') {
    out.push(`UNTIL=${range['endDate'].replace(/-/g, '')}`);
  }
  return out.join(';');
}

// ── TManage meeting <-> Graph event ──────────────────────────────────────────

/** Google's event colours by id — Outlook has no event colour, so it becomes a category. */
export const COLOUR_CATEGORIES: Record<string, string> = {
  '1': 'Lavender',
  '2': 'Sage',
  '3': 'Grape',
  '4': 'Flamingo',
  '5': 'Banana',
  '6': 'Tangerine',
  '7': 'Peacock',
  '8': 'Graphite',
  '9': 'Blueberry',
  '10': 'Basil',
  '11': 'Tomato',
};

const DEFAULT_LENGTH_MS = 30 * 60_000;

/** An instant as Graph's zone-local `dateTime` (`YYYY-MM-DDTHH:mm:ss`) in `timeZone`. */
export function localDateTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Consumer Microsoft accounts get Skype/Teams-for-life from the mailbox default, not Teams for work. */
export function isPersonalMicrosoftAccount(email: string | null): boolean {
  if (!email) return false;
  const domain = email.toLowerCase().split('@')[1] ?? '';
  return /^(outlook|hotmail|live|msn|passport)\.[a-z.]+$/.test(domain);
}

/**
 * The Graph event body for a meeting. Thrown when the meeting's recurrence cannot be said in
 * Graph's terms (the service records `recurrence_unsupported` and pushes nothing).
 */
export class RecurrenceUnsupportedError extends Error {
  override name = 'RecurrenceUnsupportedError';
}

export function toGraphEvent(
  meeting: MeetingSnapshot,
  options: { readonly personalAccount: boolean },
): Record<string, unknown> {
  const zone = meeting.timeZone ?? 'UTC';
  const end = meeting.endsAt ?? new Date(meeting.startsAt.getTime() + DEFAULT_LENGTH_MS);
  let start: Record<string, string>;
  let finish: Record<string, string>;
  if (meeting.allDay) {
    const first = dateIn(meeting.startsAt, meeting.timeZone);
    const last = meeting.endsAt ? dateIn(meeting.endsAt, meeting.timeZone) : first;
    start = { dateTime: `${first}T00:00:00`, timeZone: zone };
    // Graph's all-day end is midnight of the day after (exclusive).
    finish = { dateTime: `${addDays(last > first ? last : first, 1)}T00:00:00`, timeZone: zone };
  } else {
    start = { dateTime: localDateTime(meeting.startsAt, zone), timeZone: zone };
    finish = { dateTime: localDateTime(end, zone), timeZone: zone };
  }
  let recurrence: GraphRecurrence | null = null;
  if (meeting.recurrenceRrule) {
    recurrence = toGraphRecurrence(meeting.recurrenceRrule, meeting.startsAt, meeting.timeZone);
    if (!recurrence) throw new RecurrenceUnsupportedError('Outlook cannot repeat this way');
  }
  const body: Record<string, unknown> = {
    subject: meeting.title,
    body: { contentType: 'text', content: meeting.agendaNote ?? '' },
    start,
    end: finish,
    isAllDay: meeting.allDay,
    location: { displayName: meeting.location ?? '' },
    attendees: meeting.attendees.map((a) => ({
      emailAddress: { address: a.email, ...(a.displayName ? { name: a.displayName } : {}) },
      type: a.optional ? 'optional' : 'required',
    })),
    showAs: meeting.showAs === 'free' ? 'free' : 'busy',
    sensitivity:
      meeting.visibility === 'private'
        ? 'private'
        : meeting.visibility === 'confidential'
          ? 'confidential'
          : 'normal',
    hideAttendees: !meeting.guestsCanSeeOthers,
    allowNewTimeProposals: meeting.guestsCanModify,
    categories:
      meeting.colorId && COLOUR_CATEGORIES[meeting.colorId]
        ? [COLOUR_CATEGORIES[meeting.colorId]]
        : [],
    recurrence,
  };
  // Outlook keeps one reminder: the first one. `[]` = no reminder; `null` = the mailbox default.
  if (meeting.reminders !== null) {
    const first = meeting.reminders[0];
    body['isReminderOn'] = first !== undefined;
    if (first) body['reminderMinutesBeforeStart'] = first.minutes;
  }
  if (meeting.conference === 'teams') {
    body['isOnlineMeeting'] = true;
    // A personal account takes the mailbox's default provider; a work account asks for Teams.
    if (!options.personalAccount) body['onlineMeetingProvider'] = 'teamsForBusiness';
  } else {
    body['isOnlineMeeting'] = false;
  }
  return body;
}

/** What TManage reads back from a Graph event. */
export interface GraphEvent {
  readonly id: string;
  /** A recurring event's instance names its series here; the link holds the series id. */
  readonly seriesMasterId: string | null;
  readonly removed: boolean;
  readonly cancelled: boolean;
  readonly changeKey: string | null;
  readonly updated: Date | null;
  readonly webLink: string | null;
  readonly iCalUId: string | null;
  readonly joinUrl: string | null;
  readonly subject: string | null;
  readonly description: string | null;
  readonly location: string | null;
  readonly isAllDay: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly attendees: readonly { readonly email: string; readonly response: string }[];
}

const httpsOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.startsWith('https://') && raw.length <= 1024 ? raw : null;
const str = (raw: unknown, max = 8000): string | null =>
  typeof raw === 'string' ? raw.slice(0, max) : null;

/** Graph `dateTimeTimeZone` read in UTC (every read asks `Prefer: outlook.timezone="UTC"`). */
function utcInstant(raw: unknown): Date | null {
  const value = raw as { dateTime?: unknown; timeZone?: unknown } | undefined;
  if (typeof value?.dateTime !== 'string') return null;
  if (typeof value.timeZone === 'string' && value.timeZone.toUpperCase() !== 'UTC') return null;
  const text = /[zZ]|[+-]\d{2}:\d{2}$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseGraphEvent(body: Record<string, unknown>): GraphEvent {
  const online = body['onlineMeeting'] as { joinUrl?: unknown } | null | undefined;
  const updated =
    typeof body['lastModifiedDateTime'] === 'string'
      ? new Date(body['lastModifiedDateTime'])
      : null;
  const attendees = Array.isArray(body['attendees'])
    ? (body['attendees'] as Record<string, unknown>[])
    : [];
  const bodyContent = (body['body'] as { content?: unknown } | undefined)?.content;
  return {
    id: String(body['id'] ?? ''),
    seriesMasterId: str(body['seriesMasterId'], 255),
    removed: typeof body['@removed'] === 'object' && body['@removed'] !== null,
    cancelled: body['isCancelled'] === true,
    changeKey: str(body['changeKey'], 255),
    updated: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    webLink: httpsOrNull(body['webLink']),
    iCalUId: str(body['iCalUId'], 255),
    joinUrl: httpsOrNull(online?.joinUrl) ?? httpsOrNull(body['onlineMeetingUrl']),
    subject: str(body['subject'], 300),
    description: str(bodyContent),
    location: str((body['location'] as { displayName?: unknown } | undefined)?.displayName, 512),
    isAllDay: body['isAllDay'] === true,
    startsAt: utcInstant(body['start']),
    endsAt: utcInstant(body['end']),
    attendees: attendees
      .map((a) => ({
        address: (a?.['emailAddress'] as { address?: unknown } | undefined)?.address,
        response: (a?.['status'] as { response?: unknown } | undefined)?.response,
      }))
      .filter((a): a is { address: string; response: unknown } => typeof a.address === 'string')
      .map((a) => ({
        email: a.address.toLowerCase(),
        response: typeof a.response === 'string' ? a.response : 'none',
      })),
  };
}

/** Graph's answer vocabulary to TManage's. */
export function rsvpFromGraph(response: string): StoredAttendeeRsvp {
  switch (response) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentativelyAccepted':
      return 'tentative';
    default:
      return 'invited';
  }
}

/** The Graph action that gives this answer, or `null` (Graph cannot "un-answer"). */
export function graphResponseAction(
  rsvp: StoredAttendeeRsvp,
): 'accept' | 'decline' | 'tentativelyAccept' | null {
  if (rsvp === 'accepted') return 'accept';
  if (rsvp === 'declined') return 'decline';
  if (rsvp === 'tentative') return 'tentativelyAccept';
  return null;
}

/** A Graph `referenceAttachment` for a OneDrive link (Outlook shows it as a cloud file). */
export function referenceAttachment(input: {
  readonly title: string;
  readonly webUrl: string;
  readonly personalAccount: boolean;
}): Record<string, unknown> {
  return {
    '@odata.type': '#microsoft.graph.referenceAttachment',
    name: input.title.slice(0, 255),
    sourceUrl: input.webUrl,
    providerType: input.personalAccount ? 'oneDriveConsumer' : 'oneDriveBusiness',
    permission: 'view',
    isFolder: false,
  };
}

// ── The transport ────────────────────────────────────────────────────────────

export interface MicrosoftCalendarTokens {
  readonly accessToken: string;
  /** Microsoft rotates it: a refresh answers with a new one the caller must store. */
  readonly refreshToken: string | null;
  readonly email: string | null;
  readonly scope: string | null;
  readonly expiresInSeconds: number;
}

export interface DeltaPage {
  readonly events: readonly GraphEvent[];
  readonly nextLink: string | null;
  readonly deltaLink: string | null;
}

/** Microsoft refused the grant (expired, revoked, password changed): the connection goes to error. */
export class MicrosoftCalendarGrantRevokedError extends Error {
  override name = 'MicrosoftCalendarGrantRevokedError';
}
/** No such event in this mailbox. */
export class MicrosoftCalendarEventNotFoundError extends Error {
  override name = 'MicrosoftCalendarEventNotFoundError';
}
/** The stored delta link is no longer valid (410 / syncStateNotFound): read the window again. */
export class MicrosoftCalendarDeltaExpiredError extends Error {
  override name = 'MicrosoftCalendarDeltaExpiredError';
}
/** Any other failure talking to Microsoft. */
export class MicrosoftCalendarUnavailableError extends Error {
  override name = 'MicrosoftCalendarUnavailableError';
}

export interface MicrosoftCalendarTransport {
  exchangeCode(input: {
    config: MicrosoftCalendarConfig;
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<MicrosoftCalendarTokens>;
  refreshTokens(input: {
    config: MicrosoftCalendarConfig;
    refreshToken: string;
  }): Promise<MicrosoftCalendarTokens>;
  createEvent(accessToken: string, event: Record<string, unknown>): Promise<GraphEvent>;
  updateEvent(
    accessToken: string,
    eventId: string,
    event: Record<string, unknown>,
  ): Promise<GraphEvent>;
  /** The organizer cancels: Outlook sends the cancellation to every attendee. */
  cancelEvent(accessToken: string, eventId: string): Promise<void>;
  getEvent(accessToken: string, eventId: string): Promise<GraphEvent>;
  /** An attendee's own copy of a meeting, found by the meeting's iCalendar uid. */
  findByICalUid(accessToken: string, iCalUId: string): Promise<GraphEvent | null>;
  respond(
    accessToken: string,
    eventId: string,
    action: 'accept' | 'decline' | 'tentativelyAccept',
  ): Promise<void>;
  addAttachment(
    accessToken: string,
    eventId: string,
    attachment: Record<string, unknown>,
  ): Promise<void>;
  /** One page of `calendarView/delta`: from a stored link, or a fresh window. */
  delta(
    accessToken: string,
    input: { link: string | null; from: Date; to: Date },
  ): Promise<DeltaPage>;
}

function idTokenEmail(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
      preferred_username?: unknown;
    };
    const label = typeof claims.email === 'string' ? claims.email : claims.preferred_username;
    return typeof label === 'string' ? label.toLowerCase().slice(0, 320) : null;
  } catch {
    return null;
  }
}

/** Only Graph's own links are followed (a stored cursor is never a way to call elsewhere). */
export function isGraphLink(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.startsWith(`${MSCAL_GRAPH}/`) && raw.length <= 4096;
}

/** Times come back in UTC and bodies as plain text (TManage's agenda note is plain text). */
const UTC_PREFER = 'outlook.timezone="UTC", outlook.body-content-type="text"';

/** `fetch` is looked up per call (not captured at boot), so a suite can stub it. */
export function createMicrosoftCalendarTransport(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): MicrosoftCalendarTransport {
  async function call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(MSCAL_TIMEOUT_MS) });
    } catch {
      throw new MicrosoftCalendarUnavailableError('Microsoft Graph could not be reached');
    }
    if (response.status === 401) {
      throw new MicrosoftCalendarGrantRevokedError('Graph refused the token');
    }
    if (response.status === 404) throw new MicrosoftCalendarEventNotFoundError('No such event');
    if (response.status === 410) throw new MicrosoftCalendarDeltaExpiredError('Delta expired');
    if (!response.ok) {
      if (response.status === 400 && url.includes('/delta')) {
        const text = await response.text().catch(() => '');
        if (text.includes('syncStateNotFound') || text.includes('SyncStateNotFound')) {
          throw new MicrosoftCalendarDeltaExpiredError('Delta state not found');
        }
      }
      throw new MicrosoftCalendarUnavailableError(`Graph answered ${response.status}`);
    }
    return response;
  }

  async function token(
    config: MicrosoftCalendarConfig,
    form: Record<string, string>,
  ): Promise<MicrosoftCalendarTokens> {
    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint(config), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: MSCAL_SCOPES,
          ...form,
        }).toString(),
        signal: AbortSignal.timeout(MSCAL_TIMEOUT_MS),
      });
    } catch {
      throw new MicrosoftCalendarUnavailableError('Microsoft could not be reached');
    }
    if (!response.ok) {
      let error: unknown;
      try {
        error = ((await response.json()) as { error?: unknown }).error;
      } catch {
        error = undefined;
      }
      if (error === 'invalid_grant' || response.status === 401) {
        throw new MicrosoftCalendarGrantRevokedError('Microsoft refused the grant');
      }
      throw new MicrosoftCalendarUnavailableError(`Microsoft answered ${response.status}`);
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body['access_token'] !== 'string') {
      throw new MicrosoftCalendarUnavailableError('Microsoft token response had no access token');
    }
    return {
      accessToken: body['access_token'],
      refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
      email: idTokenEmail(body['id_token']),
      scope: typeof body['scope'] === 'string' ? body['scope'].slice(0, 512) : null,
      expiresInSeconds: typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600,
    };
  }

  const headers = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    prefer: UTC_PREFER,
  });
  const json = async (response: Response) =>
    parseGraphEvent((await response.json()) as Record<string, unknown>);
  const eventUrl = (eventId: string) => `${MSCAL_GRAPH}/me/events/${encodeURIComponent(eventId)}`;

  return {
    exchangeCode(input) {
      return token(input.config, {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      });
    },

    refreshTokens(input) {
      return token(input.config, {
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      });
    },

    async createEvent(accessToken, event) {
      return json(
        await call(`${MSCAL_GRAPH}/me/events`, {
          method: 'POST',
          headers: headers(accessToken),
          body: JSON.stringify(event),
        }),
      );
    },

    async updateEvent(accessToken, eventId, event) {
      return json(
        await call(eventUrl(eventId), {
          method: 'PATCH',
          headers: headers(accessToken),
          body: JSON.stringify(event),
        }),
      );
    },

    async cancelEvent(accessToken, eventId) {
      try {
        await call(`${eventUrl(eventId)}/cancel`, {
          method: 'POST',
          headers: headers(accessToken),
          body: JSON.stringify({ comment: '' }),
        });
      } catch (error) {
        // Already gone is what a cancel wants.
        if (error instanceof MicrosoftCalendarEventNotFoundError) return;
        throw error;
      }
    },

    async getEvent(accessToken, eventId) {
      return json(await call(eventUrl(eventId), { headers: headers(accessToken) }));
    },

    async findByICalUid(accessToken, iCalUId) {
      const filter = `iCalUId eq '${iCalUId.replace(/'/g, "''")}'`;
      const response = await call(
        `${MSCAL_GRAPH}/me/events?$top=1&$filter=${encodeURIComponent(filter)}`,
        { headers: headers(accessToken) },
      );
      const body = (await response.json()) as { value?: unknown };
      const first = Array.isArray(body.value) ? (body.value[0] as Record<string, unknown>) : null;
      return first && typeof first['id'] === 'string' ? parseGraphEvent(first) : null;
    },

    async respond(accessToken, eventId, action) {
      await call(`${eventUrl(eventId)}/${action}`, {
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify({ sendResponse: true }),
      });
    },

    async addAttachment(accessToken, eventId, attachment) {
      await call(`${eventUrl(eventId)}/attachments`, {
        method: 'POST',
        headers: headers(accessToken),
        body: JSON.stringify(attachment),
      });
    },

    async delta(accessToken, input) {
      const url = isGraphLink(input.link)
        ? input.link
        : `${MSCAL_GRAPH}/me/calendarView/delta?${new URLSearchParams({
            startDateTime: input.from.toISOString(),
            endDateTime: input.to.toISOString(),
          }).toString()}`;
      const response = await call(url, {
        headers: { ...headers(accessToken), prefer: `${UTC_PREFER}, odata.maxpagesize=50` },
      });
      const body = (await response.json()) as Record<string, unknown>;
      const items = Array.isArray(body['value'])
        ? (body['value'] as Record<string, unknown>[])
        : [];
      const next = body['@odata.nextLink'];
      const delta = body['@odata.deltaLink'];
      return {
        events: items.filter((i) => typeof i?.['id'] === 'string').map(parseGraphEvent),
        nextLink: isGraphLink(next) ? next : null,
        deltaLink: isGraphLink(delta) ? delta : null,
      };
    },
  };
}
