import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  CalendarConnectionRow,
  MeetingExternalEventRow,
  MeetingRow,
} from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { SeedCipher } from '../identity/seed-cipher.js';
import { MeetingsRepository } from '../calendar/meetings.repository.js';
import { MeetingCalendarRepository } from '../calendar/meeting-calendar.repository.js';
import type { CalendarSyncPort } from '../calendar/calendar-sync.port.js';
import type { StoredAttendeeRsvp } from '../calendar/meeting-attendees.repository.js';
import { parseReminders } from '../calendar/meeting-options.js';
import {
  CalendarEventNotFoundError,
  CalendarGrantRevokedError,
  CalendarSyncTokenExpiredError,
  GCAL_CALLBACK_PATH,
  calendarAuthorizationUrl,
  calendarStateMatches,
  newCalendarFlow,
  rsvpFromGoogle,
  rsvpToGoogle,
  toGoogleEvent,
  type CalendarConfig,
  type CalendarFlow,
  type CalendarTransport,
  type GoogleEvent,
  type MeetingSnapshot,
} from './google-calendar.google.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import type { CalendarProviderAdapter } from './calendar-sync.job.js';

/**
 * Google Calendar + Meet for meetings (0237) — the application service.
 *
 * - **A person's own connection.** Connect, complete, status and disconnect act on the caller's
 *   own row only (`user_id = context.userId`); nobody connects or reads someone else's calendar.
 * - **Push** ({@link pushMeeting}) uses the meeting ORGANIZER's connection (the meeting's creator),
 *   because Google creates an event, sends its invitations and mints its Meet link in the calendar
 *   of the account that authorised. It runs after the meeting's transaction committed, never inside
 *   one, and never throws: a failure is written on the link (`sync_status = 'error'`).
 * - **Pull** ({@link pullConnection}, the sync job; {@link pullMeeting}, "pull on open") applies the
 *   organizer's copy: answers by email onto the roster, and outside edits when Google's copy is newer.
 *
 * The refresh token is decrypted only in {@link accessToken}; access tokens are cached in memory
 * for their lifetime minus a minute and never leave this file.
 */

export const GOOGLE = 'google';

export interface CalendarConnectionStatusView {
  /** False when no Google client is set in the environment: the feature is off. */
  readonly configured: boolean;
  readonly google: {
    readonly status: 'not_connected' | 'connected' | 'error';
    /** The caller's own Google address (this view is only ever the caller's own). */
    readonly accountEmail: string | null;
    readonly connectedAt: string | null;
    readonly lastSyncedAt: string | null;
    readonly lastErrorCode: string | null;
  };
}

export interface GoogleCalendarServiceDeps {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly transport: CalendarTransport;
  readonly cipher: SeedCipher;
  readonly config: CalendarConfig | null;
  /** `API_PUBLIC_URL`: the redirect is `${apiPublicUrl}/v1/integrations/google-calendar/callback`. */
  readonly apiPublicUrl: string;
  readonly connections?: GoogleCalendarRepository;
  readonly meetings?: MeetingsRepository;
  readonly calendar?: MeetingCalendarRepository;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

/** The additional data binding a stored refresh token to its organization, person and provider. */
export function calendarTokenBinding(organizationId: string, userId: string): { userId: string } {
  return { userId: `calendar:${organizationId}:${userId}:google` };
}

/** How far back a first (or reset) pull reads. */
export const FULL_PULL_BACK_MS = 30 * 86_400_000;
const MAX_PAGES_PER_PULL = 20;

type Live = CalendarConnectionRow & { refreshTokenEnc: string };

function conflict(detail: 'not_configured' | 'unreachable'): ApiError {
  const messages = {
    not_configured: 'Google Calendar is not set up for TManage yet',
    unreachable: 'Google Calendar is not reachable. Reconnect it in Connected apps',
  } as const;
  return new ApiError(409, 'conflict', messages[detail], [{ field: 'calendar', message: detail }]);
}

function errorCode(error: unknown): string {
  if (error instanceof CalendarGrantRevokedError) return 'revoked';
  if (error instanceof CalendarEventNotFoundError) return 'event_not_found';
  return 'unavailable';
}

export class GoogleCalendarService implements CalendarSyncPort, CalendarProviderAdapter {
  readonly provider = GOOGLE;
  private readonly connections: GoogleCalendarRepository;
  private readonly meetings: MeetingsRepository;
  private readonly calendar: MeetingCalendarRepository;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly deps: GoogleCalendarServiceDeps) {
    this.connections = deps.connections ?? new GoogleCalendarRepository();
    this.meetings = deps.meetings ?? new MeetingsRepository();
    this.calendar = deps.calendar ?? new MeetingCalendarRepository();
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => console.warn(line));
  }

  get redirectUri(): string {
    return `${this.deps.apiPublicUrl.replace(/\/+$/, '')}${GCAL_CALLBACK_PATH}`;
  }

  // ── The caller's own connection ───────────────────────────────────────────

  async status(context: TenantContext): Promise<CalendarConnectionStatusView> {
    const row = await this.deps.database.read(context, (runner) =>
      this.connections.findFor(runner, context, context.userId, GOOGLE),
    );
    return this.toStatus(row);
  }

  startConnect(
    context: TenantContext,
    organizationSlug: string,
  ): { readonly url: string; readonly flow: CalendarFlow } {
    const config = this.requireConfig();
    const flow = newCalendarFlow({
      organizationId: context.organizationId,
      organizationSlug,
      userId: context.userId,
    });
    return {
      url: calendarAuthorizationUrl({
        clientId: config.clientId,
        redirectUri: this.redirectUri,
        flow,
      }),
      flow,
    };
  }

  /**
   * Finish connecting. The flow must have been started by this person in this organization and the
   * returned `state` must equal the cookie's — a code replayed into another browser, organization
   * or person is refused before Google is called.
   */
  async completeConnect(
    context: TenantContext,
    flow: CalendarFlow | undefined,
    input: { code: unknown; state: unknown },
  ): Promise<CalendarConnectionStatusView> {
    const config = this.requireConfig();
    if (
      !flow ||
      flow.organizationId !== context.organizationId ||
      flow.userId !== context.userId ||
      !calendarStateMatches(flow, input.state) ||
      typeof input.code !== 'string' ||
      input.code === '' ||
      input.code.length > 2048
    ) {
      throw new ApiError(400, 'validation_failed', 'The Google sign-in could not be completed');
    }
    let tokens;
    try {
      tokens = await this.deps.transport.exchangeCode({
        code: input.code,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: this.redirectUri,
        verifier: flow.verifier,
      });
    } catch {
      throw conflict('unreachable');
    }
    if (!tokens.refreshToken) throw conflict('unreachable');
    if (tokens.scope !== null && !tokens.scope.includes('calendar.events')) {
      // The person unticked the calendar box on Google's consent screen.
      throw new ApiError(400, 'validation_failed', 'Google did not grant calendar access', [
        { field: 'scope', message: 'calendar_not_granted' },
      ]);
    }
    const refreshTokenEnc = this.deps.cipher.encrypt(
      tokens.refreshToken,
      calendarTokenBinding(context.organizationId, context.userId),
    );
    const row = await this.deps.database.transaction(context, async (tx) => {
      await this.connections.saveConnected(tx, context, GOOGLE, {
        accountEmail: tokens.email,
        refreshTokenEnc,
        grantedScopes: tokens.scope,
      });
      const saved = await this.connections.findFor(tx, context, context.userId, GOOGLE);
      await this.deps.audit.record(tx, context, {
        action: 'calendar_connection.connected',
        result: 'allowed',
        objectId: saved?.id ?? null,
        metadata: { provider: GOOGLE },
      });
      return saved;
    });
    if (row) this.tokens.delete(row.id);
    return this.toStatus(row);
  }

  /** Disconnect: revoke at Google (best effort) and wipe the token. Meetings keep their links. */
  async disconnect(context: TenantContext): Promise<CalendarConnectionStatusView> {
    const connection = await this.deps.database.read(context, (runner) =>
      this.connections.findFor(runner, context, context.userId, GOOGLE),
    );
    if (!connection || connection.status === 'disconnected') return this.toStatus(connection);
    if (connection.refreshTokenEnc) {
      try {
        await this.deps.transport.revoke(
          this.deps.cipher.decrypt(
            connection.refreshTokenEnc,
            calendarTokenBinding(context.organizationId, context.userId),
          ),
        );
      } catch {
        // A token that cannot be opened or revoked is wiped below all the same.
      }
    }
    this.tokens.delete(connection.id);
    const row = await this.deps.database.transaction(context, async (tx) => {
      await this.connections.update(tx, context, connection.id, {
        status: 'disconnected',
        refreshTokenEnc: null,
        syncCursor: null,
        lastErrorCode: null,
        disconnectedAt: this.now(),
      });
      await this.deps.audit.record(tx, context, {
        action: 'calendar_connection.disconnected',
        result: 'allowed',
        objectId: connection.id,
        metadata: { provider: GOOGLE },
      });
      return this.connections.findFor(tx, context, context.userId, GOOGLE);
    });
    return this.toStatus(row);
  }

  // ── Push ──────────────────────────────────────────────────────────────────

  async pushMeeting(context: TenantContext, meetingId: string): Promise<void> {
    if (!this.deps.config) return;
    let state;
    try {
      state = await this.deps.database.read(context, async (runner) => {
        const meeting = await this.meetings.findById(runner, context, meetingId);
        if (!meeting) return null;
        const connection = await this.connections.findFor(
          runner,
          context,
          meeting.createdByUserId,
          GOOGLE,
        );
        const link = await this.calendar.findLink(runner, context, meetingId, GOOGLE);
        const organizerEmail = await this.connections.userEmail(runner, meeting.createdByUserId);
        return {
          meeting,
          connection,
          link,
          snapshot: await this.snapshot(runner, context, meeting, [
            organizerEmail,
            connection?.accountEmail ?? null,
          ]),
        };
      });
    } catch (error) {
      this.log(`[calendar] reading meeting ${meetingId} for push failed: ${String(error)}`);
      return;
    }
    if (!state) return;
    const { meeting, connection, link, snapshot } = state;
    // A meeting whose organizer has not connected Google stays TManage-only (no link is made).
    if (!connection || connection.status !== 'connected' || !connection.refreshTokenEnc) {
      if (link && link.syncStatus !== 'deleted') {
        await this.markLink(context, link, { syncStatus: 'error', lastErrorCode: 'not_connected' });
      }
      return;
    }
    const live = connection as Live;
    try {
      const accessToken = await this.accessToken(context, live);
      const calendarId = link?.externalCalendarId ?? live.calendarId;
      if (snapshot.cancelled) {
        if (link?.externalEventId) {
          await this.deps.transport.deleteEvent(accessToken, calendarId, link.externalEventId);
          await this.markLink(context, link, {
            syncStatus: 'deleted',
            lastErrorCode: null,
            lastPushedAt: this.now(),
          });
        }
        return;
      }
      const body = toGoogleEvent(snapshot, {
        withConference: !link?.joinUrl,
        requestId: `${meeting.id}-${meeting.updatedAt.getTime()}`.slice(0, 64),
      });
      const event = link?.externalEventId
        ? await this.deps.transport.patchEvent(
            accessToken,
            calendarId,
            link.externalEventId,
            body,
            'all',
          )
        : await this.deps.transport.insertEvent(accessToken, calendarId, body);
      await this.deps.database.transaction(context, (tx) =>
        this.calendar.saveLink(tx, context, meetingId, GOOGLE, {
          connectionId: live.id,
          externalEventId: event.id,
          externalCalendarId: calendarId,
          icalUid: event.iCalUID,
          joinUrl: event.joinUrl ?? link?.joinUrl ?? null,
          htmlLink: event.htmlLink,
          externalVersion: event.etag,
          syncStatus: 'synced',
          lastErrorCode: null,
          lastPushedAt: this.now(),
        }),
      );
    } catch (error) {
      await this.recordFailure(context, live, error);
      try {
        await this.deps.database.transaction(context, (tx) =>
          this.calendar.saveLink(tx, context, meetingId, GOOGLE, {
            connectionId: live.id,
            syncStatus: 'error',
            lastErrorCode: errorCode(error),
          }),
        );
      } catch (inner) {
        this.log(`[calendar] recording push failure for ${meetingId} failed: ${String(inner)}`);
      }
    }
  }

  /**
   * A TManage answer goes to Google. With the person's own Google connection, their own copy of the
   * event is patched (Google tells the organizer); otherwise the organizer's event gets the answer
   * on that attendee's entry, without sending mail. Best effort, never throws.
   */
  async forwardRsvp(
    context: TenantContext,
    meetingId: string,
    userId: string,
    rsvp: StoredAttendeeRsvp,
  ): Promise<void> {
    if (!this.deps.config) return;
    try {
      const state = await this.deps.database.read(context, async (runner) => {
        const link = await this.calendar.findLink(runner, context, meetingId, GOOGLE);
        if (!link?.externalEventId || link.syncStatus === 'deleted') return null;
        return {
          link,
          own: await this.connections.findFor(runner, context, userId, GOOGLE),
          organizer: await this.connections.findById(runner, context, link.connectionId),
          email: await this.connections.userEmail(runner, userId),
        };
      });
      if (!state?.email || !state.link.externalEventId) return;
      const eventId = state.link.externalEventId;
      const own = state.own?.status === 'connected' && state.own.refreshTokenEnc ? state.own : null;
      const via = own ?? state.organizer;
      if (!via || via.status !== 'connected' || !via.refreshTokenEnc) return;
      const accessToken = await this.accessToken(context, via as Live);
      const calendarId = own ? own.calendarId : (state.link.externalCalendarId ?? via.calendarId);
      const event = await this.deps.transport.getEvent(accessToken, calendarId, eventId);
      const attendees = event.rawAttendees.map((entry) =>
        String(entry['email'] ?? '').toLowerCase() === state.email ||
        (own !== null && entry['self'] === true)
          ? { ...entry, responseStatus: rsvpToGoogle(rsvp) }
          : entry,
      );
      await this.deps.transport.patchEvent(
        accessToken,
        calendarId,
        eventId,
        { attendees },
        own ? 'all' : 'none',
      );
    } catch (error) {
      this.log(`[calendar] forwarding an answer for ${meetingId} failed: ${errorCode(error)}`);
    }
  }

  // ── Pull ──────────────────────────────────────────────────────────────────

  async pullMeeting(context: TenantContext, meetingId: string, maxAgeMs: number): Promise<void> {
    if (!this.deps.config) return;
    try {
      const state = await this.deps.database.read(context, async (runner) => {
        const link = await this.calendar.findLink(runner, context, meetingId, GOOGLE);
        if (!link?.externalEventId || link.syncStatus === 'deleted') return null;
        const fresh =
          link.lastPulledAt && this.now().getTime() - link.lastPulledAt.getTime() < maxAgeMs;
        if (fresh) return null;
        return {
          link,
          connection: await this.connections.findById(runner, context, link.connectionId),
        };
      });
      if (!state?.connection || state.connection.status !== 'connected') return;
      if (!state.connection.refreshTokenEnc || !state.link.externalEventId) return;
      const accessToken = await this.accessToken(context, state.connection as Live);
      let event: GoogleEvent;
      try {
        event = await this.deps.transport.getEvent(
          accessToken,
          state.link.externalCalendarId ?? state.connection.calendarId,
          state.link.externalEventId,
        );
      } catch (error) {
        if (!(error instanceof CalendarEventNotFoundError)) throw error;
        event = { ...emptyEvent(state.link.externalEventId), status: 'cancelled' };
      }
      await this.apply(context, state.link, event);
    } catch (error) {
      this.log(`[calendar] pulling meeting ${meetingId} failed: ${errorCode(error)}`);
    }
  }

  /**
   * The sync job's pass over one connection: Google's changes since the stored sync token (a full
   * 30-day window the first time, or after Google expired the token), applied to the meetings this
   * connection organizes. Events TManage does not know are ignored.
   */
  async pullConnection(context: TenantContext, connectionId: string): Promise<void> {
    if (!this.deps.config) return;
    const connection = await this.deps.database.read(context, (runner) =>
      this.connections.findById(runner, context, connectionId),
    );
    if (!connection || connection.status !== 'connected' || !connection.refreshTokenEnc) return;
    const live = connection as Live;
    try {
      const accessToken = await this.accessToken(context, live);
      let cursor = live.syncCursor;
      let next: string | null = null;
      try {
        next = await this.walk(context, live, accessToken, cursor);
      } catch (error) {
        if (!(error instanceof CalendarSyncTokenExpiredError) || cursor === null) throw error;
        cursor = null;
        next = await this.walk(context, live, accessToken, null);
      }
      await this.deps.database.transaction(context, (tx) =>
        this.connections.update(tx, context, live.id, {
          syncCursor: next ?? cursor,
          lastSyncedAt: this.now(),
          lastErrorCode: null,
        }),
      );
    } catch (error) {
      await this.recordFailure(context, live, error);
    }
  }

  private async walk(
    context: TenantContext,
    connection: Live,
    accessToken: string,
    syncToken: string | null,
  ): Promise<string | null> {
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
      const result = await this.deps.transport.listChanges(accessToken, connection.calendarId, {
        syncToken,
        timeMin: new Date(this.now().getTime() - FULL_PULL_BACK_MS),
        pageToken,
      });
      for (const event of result.events) {
        const link = await this.deps.database.read(context, (runner) =>
          this.calendar.findLinkByEvent(runner, context, connection.id, event.id),
        );
        if (link) await this.apply(context, link, event);
      }
      if (result.nextSyncToken) return result.nextSyncToken;
      if (!result.nextPageToken) return null;
      pageToken = result.nextPageToken;
    }
    return null;
  }

  /** Apply the organizer's copy of an event to the meeting it is linked to. */
  private async apply(
    context: TenantContext,
    link: MeetingExternalEventRow,
    event: GoogleEvent,
  ): Promise<void> {
    await this.deps.database.transaction(context, async (tx) => {
      const meeting = await this.meetings.findById(tx, context, link.meetingId);
      if (!meeting) return;
      if (event.status === 'cancelled') {
        if (!meeting.cancelledAt) {
          await this.meetings.update(tx, context, meeting.id, { cancelledAt: this.now() });
        }
        await this.calendar.patchLink(tx, context, link.id, {
          syncStatus: 'deleted',
          lastPulledAt: this.now(),
        });
        return;
      }
      const roster = await this.calendar.roster(tx, context, meeting.id);
      const byEmail = new Map(roster.map((entry) => [entry.email, entry]));
      for (const attendee of event.attendees) {
        const entry = byEmail.get(attendee.email);
        const rsvp = rsvpFromGoogle(attendee.responseStatus);
        // The organizer's own row stays as TManage set it (Google reports the organizer too).
        if (entry && entry.rsvp !== rsvp && entry.userId !== meeting.createdByUserId) {
          await this.calendar.setRosterRsvp(tx, context, entry, meeting.id, rsvp);
        }
      }
      // Edits made in Google win when Google's copy is newer than TManage's.
      if (event.updated && event.updated.getTime() > meeting.updatedAt.getTime()) {
        const patch = editsFrom(meeting, event);
        if (patch) await this.meetings.update(tx, context, meeting.id, patch);
      }
      await this.calendar.patchLink(tx, context, link.id, {
        externalVersion: event.etag,
        ...(event.joinUrl ? { joinUrl: event.joinUrl } : {}),
        ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
        syncStatus: link.syncStatus === 'error' ? 'error' : 'synced',
        lastPulledAt: this.now(),
      });
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async snapshot(
    runner: Parameters<MeetingCalendarRepository['roster']>[0],
    context: TenantContext,
    meeting: MeetingRow,
    organizerEmails: readonly (string | null)[],
  ): Promise<MeetingSnapshot> {
    const roster = await this.calendar.roster(runner, context, meeting.id);
    const attachments = await this.calendar.listAttachments(runner, context, meeting.id);
    const organizer = new Set(organizerEmails.filter((e): e is string => e !== null));
    return {
      id: meeting.id,
      title: meeting.title,
      agendaNote: meeting.agendaNote,
      startsAt: meeting.startsAt,
      endsAt: meeting.endsAt,
      allDay: meeting.allDay,
      timeZone: meeting.timeZone,
      location: meeting.location,
      recurrenceRrule: meeting.recurrenceRrule,
      visibility: meeting.visibility,
      showAs: meeting.showAs,
      colorId: meeting.colorId,
      conference: meeting.conference,
      reminders: parseReminders(meeting.reminders),
      guestsCanModify: meeting.guestsCanModify,
      guestsCanInviteOthers: meeting.guestsCanInviteOthers,
      guestsCanSeeOthers: meeting.guestsCanSeeOthers,
      cancelled: meeting.cancelledAt !== null,
      attendees: roster
        .filter((entry) => entry.userId !== meeting.createdByUserId && !organizer.has(entry.email))
        .map((entry) => ({
          email: entry.email,
          optional: entry.optional,
          displayName: entry.displayName,
        })),
      attachments: attachments
        .filter((a) => a.provider === 'google_drive' && a.webUrl)
        .map((a) => ({ fileUrl: a.webUrl as string, title: a.title, mimeType: a.mimeType })),
    };
  }

  private async accessToken(context: TenantContext, connection: Live): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.token;
    const config = this.requireConfig();
    const refreshToken = this.deps.cipher.decrypt(
      connection.refreshTokenEnc,
      calendarTokenBinding(context.organizationId, connection.userId),
    );
    const fresh = await this.deps.transport.refreshAccessToken({
      refreshToken,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    this.tokens.set(connection.id, {
      token: fresh.accessToken,
      expiresAt: this.now().getTime() + Math.max(fresh.expiresInSeconds - 60, 0) * 1000,
    });
    return fresh.accessToken;
  }

  /** A refused grant moves the connection to `error` ("Reconnect"); anything else is logged. */
  private async recordFailure(context: TenantContext, connection: Live, error: unknown) {
    this.log(`[calendar] Google call for connection ${connection.id} failed: ${errorCode(error)}`);
    if (!(error instanceof CalendarGrantRevokedError)) return;
    this.tokens.delete(connection.id);
    try {
      await this.deps.database.transaction(context, (tx) =>
        this.connections.update(tx, context, connection.id, {
          status: 'error',
          lastErrorCode: 'revoked',
        }),
      );
    } catch (inner) {
      this.log(`[calendar] marking connection ${connection.id} revoked failed: ${String(inner)}`);
    }
  }

  private async markLink(
    context: TenantContext,
    link: MeetingExternalEventRow,
    patch: Parameters<MeetingCalendarRepository['patchLink']>[3],
  ): Promise<void> {
    try {
      await this.deps.database.transaction(context, (tx) =>
        this.calendar.patchLink(tx, context, link.id, patch),
      );
    } catch (error) {
      this.log(`[calendar] updating link ${link.id} failed: ${String(error)}`);
    }
  }

  private requireConfig(): CalendarConfig {
    if (!this.deps.config) throw conflict('not_configured');
    return this.deps.config;
  }

  private toStatus(row: CalendarConnectionRow | null): CalendarConnectionStatusView {
    const status =
      !row || row.status === 'disconnected'
        ? 'not_connected'
        : row.status === 'error'
          ? 'error'
          : 'connected';
    return {
      configured: this.deps.config !== null,
      google: {
        status,
        accountEmail: status === 'not_connected' ? null : (row?.accountEmail ?? null),
        connectedAt:
          status !== 'not_connected' && row?.connectedAt ? row.connectedAt.toISOString() : null,
        lastSyncedAt: row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
        lastErrorCode: status === 'error' ? (row?.lastErrorCode ?? null) : null,
      },
    };
  }
}

/** The fields Google's copy changed, as a meeting update, or `null` when nothing differs. */
export function editsFrom(
  meeting: MeetingRow,
  event: GoogleEvent,
): Parameters<MeetingsRepository['update']>[3] | null {
  const patch: {
    title?: string;
    agendaNote?: string | null;
    startsAt?: Date;
    endsAt?: Date | null;
    options?: { location: string | null };
  } = {};
  if (event.summary && event.summary !== meeting.title) patch.title = event.summary;
  const description = event.description === '' ? null : event.description;
  if (event.description !== null && description !== meeting.agendaNote)
    patch.agendaNote = description;
  const location = event.location === '' ? null : event.location;
  if (event.location !== null && location !== meeting.location) patch.options = { location };
  // An all-day Google event has dates, not instants; TManage keeps its own times then.
  if (!meeting.allDay && event.startsAt && event.endsAt && event.endsAt > event.startsAt) {
    if (event.startsAt.getTime() !== meeting.startsAt.getTime()) patch.startsAt = event.startsAt;
    if (event.endsAt.getTime() !== meeting.endsAt?.getTime()) patch.endsAt = event.endsAt;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

function emptyEvent(id: string): GoogleEvent {
  return {
    id,
    status: 'confirmed',
    etag: null,
    updated: null,
    htmlLink: null,
    iCalUID: null,
    joinUrl: null,
    summary: null,
    description: null,
    location: null,
    startsAt: null,
    endsAt: null,
    attendees: [],
    rawAttendees: [],
  };
}
