import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constantTimeEquals } from '../identity/session-token.js';
import type { MeetingReminder } from '../calendar/meeting-options.js';
import type { StoredAttendeeRsvp } from '../calendar/meeting-attendees.repository.js';

/**
 * Google Calendar + Meet for meetings (0237) — the protocol half. Nothing here touches the database.
 *
 * - **Configuration** only from the environment: `GOOGLE_CALENDAR_CLIENT_ID/SECRET`, falling back to
 *   the Drive client and then the sign-in client (`GOOGLE_CLIENT_ID/SECRET`). Missing => feature off.
 * - **Scope** `openid email …/auth/calendar.events`, with `include_granted_scopes` (incremental
 *   consent): a person who already granted Drive adds only the calendar scope. Not `calendar` (ACLs
 *   and settings we never touch) and not `calendar.events.owned` (cannot read an invitation's copy).
 * - **The flow cookie** carries `state` and the PKCE verifier, signed with `SESSION_SECRET` under its
 *   own purpose and bound to the organization and the person who started it.
 */

export const GCAL_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GCAL_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GCAL_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GCAL_API = 'https://www.googleapis.com/calendar/v3';
export const GCAL_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.events';
export const GCAL_CALLBACK_PATH = '/v1/integrations/google-calendar/callback';
export const GCAL_COOKIE_PATH = '/v1';
export const GCAL_FLOW_COOKIE = 'tm_gcal_flow';
export const GCAL_FLOW_TTL_SECONDS = 600;
const FLOW_PURPOSE = 'gcal-flow.v1';
/** Every Google call gives up after this long (push runs inside a request). */
export const GCAL_TIMEOUT_MS = 10_000;

export interface CalendarConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function value(env: Env, ...names: string[]): string | null {
  for (const name of names) {
    const raw = env[name]?.trim();
    if (raw) return raw;
  }
  return null;
}

/** The Calendar client from the environment, or `null` (feature off, "not configured"). */
export function calendarConfigFrom(env: Env): CalendarConfig | null {
  const clientId = value(
    env,
    'GOOGLE_CALENDAR_CLIENT_ID',
    'GOOGLE_DRIVE_CLIENT_ID',
    'GOOGLE_CLIENT_ID',
  );
  const clientSecret = value(
    env,
    'GOOGLE_CALENDAR_CLIENT_SECRET',
    'GOOGLE_DRIVE_CLIENT_SECRET',
    'GOOGLE_CLIENT_SECRET',
  );
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

// ── The flow cookie ──────────────────────────────────────────────────────────

export interface CalendarFlow {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly state: string;
  readonly verifier: string;
  /** Unix seconds. */
  readonly expiresAt: number;
}

const random = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function newCalendarFlow(
  owner: { organizationId: string; organizationSlug: string; userId: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CalendarFlow {
  return {
    ...owner,
    state: random(),
    verifier: random(),
    expiresAt: nowSeconds + GCAL_FLOW_TTL_SECONDS,
  };
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(`${FLOW_PURPOSE}.${payload}`).digest('base64url');
}

export function sealCalendarFlow(flow: CalendarFlow, secret: string): string {
  const payload = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** The flow, or `undefined` for a missing, forged, malformed or expired cookie. */
export function openCalendarFlow(
  raw: string | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CalendarFlow | undefined {
  if (!raw) return undefined;
  const [payload, signature, extra] = raw.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!constantTimeEquals(signature, sign(payload, secret))) return undefined;
  try {
    const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CalendarFlow;
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

export function calendarStateMatches(flow: CalendarFlow, returned: unknown): boolean {
  return typeof returned === 'string' && constantTimeEquals(flow.state, returned);
}

export function calendarAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  flow: CalendarFlow;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: GCAL_SCOPES,
    state: input.flow.state,
    code_challenge: createHash('sha256').update(input.flow.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${GCAL_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

// ── TManage meeting <-> Google event ─────────────────────────────────────────

/** Everything a provider event is built from, read by the service in one transaction. */
export interface MeetingSnapshot {
  readonly id: string;
  readonly title: string;
  readonly agendaNote: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly allDay: boolean;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly recurrenceRrule: string | null;
  readonly visibility: string;
  readonly showAs: string;
  readonly colorId: string | null;
  readonly conference: string;
  readonly reminders: readonly MeetingReminder[] | null;
  readonly guestsCanModify: boolean;
  readonly guestsCanInviteOthers: boolean;
  readonly guestsCanSeeOthers: boolean;
  readonly cancelled: boolean;
  /** Everyone but the organizer. */
  readonly attendees: readonly { email: string; optional: boolean; displayName: string | null }[];
  /** Google Drive files only (Google accepts Drive attachments only). */
  readonly attachments: readonly { fileUrl: string; title: string; mimeType: string }[];
}

const DEFAULT_LENGTH_MS = 30 * 60_000;

/** The calendar date of an instant in a zone, `YYYY-MM-DD`. */
export function dateIn(instant: Date, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The Google event body for a meeting. `withConference` asks Google to mint a Meet link (sent only
 * when the meeting wants Meet and the event has none yet; `requestId` makes the request idempotent).
 */
export function toGoogleEvent(
  meeting: MeetingSnapshot,
  options: { readonly withConference: boolean; readonly requestId: string },
): Record<string, unknown> {
  const zone = meeting.timeZone ?? 'UTC';
  const end = meeting.endsAt ?? new Date(meeting.startsAt.getTime() + DEFAULT_LENGTH_MS);
  let start: Record<string, string>;
  let finish: Record<string, string>;
  if (meeting.allDay) {
    const first = dateIn(meeting.startsAt, meeting.timeZone);
    const last = meeting.endsAt ? dateIn(meeting.endsAt, meeting.timeZone) : first;
    start = { date: first };
    // Google's all-day end date is exclusive.
    finish = { date: addDays(last > first ? last : first, 1) };
  } else {
    start = { dateTime: meeting.startsAt.toISOString(), timeZone: zone };
    finish = { dateTime: end.toISOString(), timeZone: zone };
  }
  const body: Record<string, unknown> = {
    summary: meeting.title,
    description: meeting.agendaNote ?? '',
    location: meeting.location ?? '',
    start,
    end: finish,
    recurrence: meeting.recurrenceRrule ? [`RRULE:${meeting.recurrenceRrule}`] : [],
    attendees: meeting.attendees.map((a) => ({
      email: a.email,
      ...(a.optional ? { optional: true } : {}),
      ...(a.displayName ? { displayName: a.displayName } : {}),
    })),
    visibility: meeting.visibility,
    transparency: meeting.showAs === 'free' ? 'transparent' : 'opaque',
    colorId: meeting.colorId,
    reminders:
      meeting.reminders === null
        ? { useDefault: true }
        : { useDefault: false, overrides: meeting.reminders.map((r) => ({ ...r })) },
    guestsCanModify: meeting.guestsCanModify,
    guestsCanInviteOthers: meeting.guestsCanInviteOthers,
    guestsCanSeeOtherGuests: meeting.guestsCanSeeOthers,
    attachments: meeting.attachments.map((a) => ({ ...a })),
    extendedProperties: { private: { tmanageMeetingId: meeting.id } },
  };
  if (meeting.conference === 'google_meet' && options.withConference) {
    body['conferenceData'] = {
      createRequest: {
        requestId: options.requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  } else if (meeting.conference !== 'google_meet') {
    body['conferenceData'] = null;
  }
  return body;
}

/** What TManage reads back from a Google event. */
export interface GoogleEvent {
  readonly id: string;
  /** `confirmed`, `tentative` or `cancelled`. */
  readonly status: string;
  readonly etag: string | null;
  readonly updated: Date | null;
  readonly htmlLink: string | null;
  readonly iCalUID: string | null;
  readonly joinUrl: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  readonly location: string | null;
  /** `null` for an all-day event (a date, not an instant). */
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly attendees: readonly {
    readonly email: string;
    readonly responseStatus: string;
    readonly self: boolean;
    readonly optional: boolean;
  }[];
  /** The raw attendee entries, so a patch of one answer can send the list back unchanged. */
  readonly rawAttendees: readonly Record<string, unknown>[];
}

const httpsOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.startsWith('https://') && raw.length <= 1024 ? raw : null;
const str = (raw: unknown, max = 8000): string | null =>
  typeof raw === 'string' ? raw.slice(0, max) : null;

function instant(raw: unknown): Date | null {
  const dateTime = (raw as { dateTime?: unknown } | undefined)?.dateTime;
  if (typeof dateTime !== 'string') return null;
  const parsed = new Date(dateTime);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseGoogleEvent(body: Record<string, unknown>): GoogleEvent {
  const conference = body['conferenceData'] as
    { entryPoints?: { entryPointType?: unknown; uri?: unknown }[] } | undefined;
  const video = conference?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  const rawAttendees = Array.isArray(body['attendees'])
    ? (body['attendees'] as Record<string, unknown>[]).filter((a) => typeof a === 'object' && a)
    : [];
  const updated = typeof body['updated'] === 'string' ? new Date(body['updated']) : null;
  return {
    id: String(body['id'] ?? ''),
    status: typeof body['status'] === 'string' ? body['status'] : 'confirmed',
    etag: str(body['etag'], 255),
    updated: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    htmlLink: httpsOrNull(body['htmlLink']),
    iCalUID: str(body['iCalUID'], 255),
    joinUrl: httpsOrNull(video) ?? httpsOrNull(body['hangoutLink']),
    summary: str(body['summary'], 300),
    description: str(body['description']),
    location: str(body['location'], 512),
    startsAt: instant(body['start']),
    endsAt: instant(body['end']),
    attendees: rawAttendees
      .filter((a) => typeof a['email'] === 'string')
      .map((a) => ({
        email: String(a['email']).toLowerCase(),
        responseStatus:
          typeof a['responseStatus'] === 'string' ? a['responseStatus'] : 'needsAction',
        self: a['self'] === true,
        optional: a['optional'] === true,
      })),
    rawAttendees,
  };
}

/** Google's answer vocabulary to TManage's. */
export function rsvpFromGoogle(responseStatus: string): StoredAttendeeRsvp {
  switch (responseStatus) {
    case 'accepted':
      return 'accepted';
    case 'declined':
      return 'declined';
    case 'tentative':
      return 'tentative';
    default:
      return 'invited';
  }
}

export function rsvpToGoogle(rsvp: StoredAttendeeRsvp): string {
  return rsvp === 'invited' ? 'needsAction' : rsvp;
}

// ── The transport ────────────────────────────────────────────────────────────

export interface CalendarTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly email: string | null;
  readonly scope: string | null;
}

export interface ChangesPage {
  readonly events: readonly GoogleEvent[];
  readonly nextPageToken: string | null;
  readonly nextSyncToken: string | null;
}

/** Google refused the grant (expired or revoked): the connection moves to the error state. */
export class CalendarGrantRevokedError extends Error {
  override name = 'CalendarGrantRevokedError';
}
/** No such event in this calendar (deleted, or never shared with this person). */
export class CalendarEventNotFoundError extends Error {
  override name = 'CalendarEventNotFoundError';
}
/** The stored sync token is too old (HTTP 410): the next read must be a full one. */
export class CalendarSyncTokenExpiredError extends Error {
  override name = 'CalendarSyncTokenExpiredError';
}
/** Any other failure talking to Google. */
export class CalendarUnavailableError extends Error {
  override name = 'CalendarUnavailableError';
}

export interface CalendarTransport {
  exchangeCode(input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    verifier: string;
  }): Promise<CalendarTokens>;
  refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<{ readonly accessToken: string; readonly expiresInSeconds: number }>;
  revoke(token: string): Promise<void>;
  insertEvent(
    accessToken: string,
    calendarId: string,
    event: Record<string, unknown>,
  ): Promise<GoogleEvent>;
  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    event: Record<string, unknown>,
    sendUpdates: 'all' | 'none',
  ): Promise<GoogleEvent>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<GoogleEvent>;
  /** One page of changes since `syncToken`, or (no token) of the window from `timeMin`. */
  listChanges(
    accessToken: string,
    calendarId: string,
    input: { syncToken: string | null; timeMin: Date; pageToken: string | null },
  ): Promise<ChangesPage>;
}

function decodeEmail(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

const eventPath = (calendarId: string, eventId?: string) =>
  `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events${
    eventId === undefined ? '' : `/${encodeURIComponent(eventId)}`
  }`;

/** `fetch` is looked up per call (not captured at boot), so a suite can stub it. */
export function createCalendarTransport(
  fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init),
): CalendarTransport {
  async function call(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(GCAL_TIMEOUT_MS) });
    } catch {
      throw new CalendarUnavailableError('Google Calendar could not be reached');
    }
    if (response.status === 401) throw new CalendarGrantRevokedError('Google refused the token');
    if (response.status === 404) throw new CalendarEventNotFoundError('No such event');
    if (response.status === 410) throw new CalendarSyncTokenExpiredError('Sync token expired');
    if (!response.ok) {
      throw new CalendarUnavailableError(`Google Calendar answered ${response.status}`);
    }
    return response;
  }
  const json = async (response: Response) =>
    parseGoogleEvent((await response.json()) as Record<string, unknown>);
  const headers = (accessToken: string) => ({
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  });

  return {
    async exchangeCode(input) {
      const response = await call(GCAL_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }).toString(),
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['access_token'] !== 'string') {
        throw new CalendarUnavailableError('Google token response had no access token');
      }
      return {
        accessToken: body['access_token'],
        refreshToken: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : null,
        email: decodeEmail(body['id_token']),
        scope: typeof body['scope'] === 'string' ? body['scope'].slice(0, 512) : null,
      };
    },

    async refreshAccessToken(input) {
      let response: Response;
      try {
        response = await fetchImpl(GCAL_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: input.refreshToken,
            client_id: input.clientId,
            client_secret: input.clientSecret,
          }).toString(),
          signal: AbortSignal.timeout(GCAL_TIMEOUT_MS),
        });
      } catch {
        throw new CalendarUnavailableError('Google could not be reached');
      }
      // `invalid_grant` (400) is the one answer that means "expired or revoked".
      if (response.status === 400 || response.status === 401) {
        throw new CalendarGrantRevokedError('Google refused the refresh token');
      }
      if (!response.ok) throw new CalendarUnavailableError(`Google answered ${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body['access_token'] !== 'string') {
        throw new CalendarUnavailableError('Google refresh response had no access token');
      }
      const expires = typeof body['expires_in'] === 'number' ? body['expires_in'] : 3600;
      return { accessToken: body['access_token'], expiresInSeconds: expires };
    },

    async revoke(token) {
      await fetchImpl(GCAL_REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      }).catch(() => undefined);
    },

    async insertEvent(accessToken, calendarId, event) {
      const query = 'conferenceDataVersion=1&sendUpdates=all&supportsAttachments=true';
      return json(
        await call(`${eventPath(calendarId)}?${query}`, {
          method: 'POST',
          headers: headers(accessToken),
          body: JSON.stringify(event),
        }),
      );
    },

    async patchEvent(accessToken, calendarId, eventId, event, sendUpdates) {
      const query = `conferenceDataVersion=1&sendUpdates=${sendUpdates}&supportsAttachments=true`;
      return json(
        await call(`${eventPath(calendarId, eventId)}?${query}`, {
          method: 'PATCH',
          headers: headers(accessToken),
          body: JSON.stringify(event),
        }),
      );
    },

    async deleteEvent(accessToken, calendarId, eventId) {
      try {
        await call(`${eventPath(calendarId, eventId)}?sendUpdates=all`, {
          method: 'DELETE',
          headers: headers(accessToken),
        });
      } catch (error) {
        // Already gone (404) or already deleted (410) is what a delete wants.
        if (error instanceof CalendarEventNotFoundError) return;
        if (error instanceof CalendarSyncTokenExpiredError) return;
        throw error;
      }
    },

    async getEvent(accessToken, calendarId, eventId) {
      return json(await call(eventPath(calendarId, eventId), { headers: headers(accessToken) }));
    },

    async listChanges(accessToken, calendarId, input) {
      const params = new URLSearchParams({ maxResults: '250', showDeleted: 'true' });
      if (input.syncToken) params.set('syncToken', input.syncToken);
      else params.set('timeMin', input.timeMin.toISOString());
      if (input.pageToken) params.set('pageToken', input.pageToken);
      const response = await call(`${eventPath(calendarId)}?${params.toString()}`, {
        headers: headers(accessToken),
      });
      const body = (await response.json()) as {
        items?: unknown;
        nextPageToken?: unknown;
        nextSyncToken?: unknown;
      };
      const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
      const token = (raw: unknown) => (typeof raw === 'string' && raw.length <= 2048 ? raw : null);
      return {
        events: items.filter((i) => typeof i?.['id'] === 'string').map(parseGoogleEvent),
        nextPageToken: token(body.nextPageToken),
        nextSyncToken: token(body.nextSyncToken),
      };
    },
  };
}
