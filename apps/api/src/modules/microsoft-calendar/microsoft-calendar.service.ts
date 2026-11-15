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
import { pushProviderFor } from '../calendar/calendar-provider.js';
import { applyProviderAnswers } from '../calendar/provider-answers.js';
import type { ApplyProviderAnswersDeps } from '../calendar/provider-answers.js';
import { MeetingRsvpRepository } from '../calendar/rsvp.repository.js';
import { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { CalendarProviderAdapter, PullOutcome } from '../google-calendar/calendar-sync.job.js';
import type { GoogleEvent, MeetingSnapshot } from '../google-calendar/google-calendar.google.js';
import { editsFrom } from '../google-calendar/google-calendar.service.js';
import {
  MSCAL_CALLBACK_PATH,
  MicrosoftCalendarDeltaExpiredError,
  MicrosoftCalendarEventNotFoundError,
  MicrosoftCalendarGrantRevokedError,
  RecurrenceUnsupportedError,
  graphResponseAction,
  isPersonalMicrosoftAccount,
  microsoftCalendarAuthorizationUrl,
  microsoftCalendarStateMatches,
  newMicrosoftCalendarFlow,
  referenceAttachment,
  rsvpFromGraph,
  toGraphEvent,
  type GraphEvent,
  type MicrosoftCalendarConfig,
  type MicrosoftCalendarFlow,
  type MicrosoftCalendarTransport,
} from './microsoft-calendar.graph.js';
import { MicrosoftCalendarRepository } from './microsoft-calendar.repository.js';
import { CalendarSyncExtras, healthOf, nextDay } from '../google-calendar/calendar-sync-extras.js';
import type {
  AllDayEvent,
  CalendarHealthFields,
  CalendarRemote,
  RemoteSession,
} from '../google-calendar/calendar-sync-extras.js';
import {
  GRAPH_SUBSCRIPTION_TTL_MS,
  PUSH_PATH_MICROSOFT,
} from '../google-calendar/calendar-push.js';

/**
 * Outlook calendar + Teams meetings (0237, slice B) — the application service. The twin of
 * `GoogleCalendarService`, over the same provider-generic tables with `provider = 'microsoft'`.
 *
 * - **A person's own connection.** Connect, complete, status and disconnect act on the caller's
 *   own row only (`user_id = context.userId`).
 * - **Push** ({@link pushMeeting}) uses the meeting ORGANIZER's Outlook connection — Outlook sends
 *   the invitations and mints the Teams link in the mailbox that authorised — and only when the one
 *   rule in `calendar-provider.ts` picks Outlook (an organizer with both calendars gets one event).
 *   It runs after the meeting's transaction committed and never throws: a failure is written on
 *   the link (`sync_status = 'error'`).
 * - **Pull** ({@link pullConnection}, the sync job, over `calendarView/delta`; {@link pullMeeting},
 *   "pull on open") applies the organizer's copy: answers by email onto the roster, and outside
 *   edits when Outlook's copy is newer.
 * - **Refresh tokens rotate.** Each refresh that returns a new one is re-encrypted and stored.
 *   Microsoft has no revoke endpoint; a disconnect wipes the stored token.
 */

export const MICROSOFT = 'microsoft';

export interface MicrosoftCalendarStatusView {
  /** False when no Microsoft client is set in the environment: the feature is off. */
  readonly configured: boolean;
  readonly microsoft: {
    readonly status: 'not_connected' | 'connected' | 'error';
    /** The caller's own Microsoft address (this view is only ever the caller's own). */
    readonly accountEmail: string | null;
    readonly connectedAt: string | null;
    readonly lastSyncedAt: string | null;
    readonly lastErrorCode: string | null;
  } & CalendarHealthFields;
}

export interface MicrosoftCalendarServiceDeps {
  readonly database: TenantDatabase;
  readonly audit: AuditService;
  readonly transport: MicrosoftCalendarTransport;
  readonly cipher: SeedCipher;
  readonly config: MicrosoftCalendarConfig | null;
  /** `API_PUBLIC_URL`: the redirect is `${apiPublicUrl}/v1/integrations/microsoft-calendar/callback`. */
  readonly apiPublicUrl: string;
  /** Whether Google Calendar is set up too (the provider rule needs to know). */
  readonly googleConfigured: boolean;
  readonly connections?: MicrosoftCalendarRepository;
  readonly meetings?: MeetingsRepository;
  readonly calendar?: MeetingCalendarRepository;
  /** Fix 2026-11-09: a member's answer from Outlook also lands in `meeting_rsvps`. */
  readonly rsvps?: MeetingRsvpRepository;
  /** Fix 2026-11-09: the organizer is told of an answer (`meeting.attendee_responded.v1`). */
  readonly outbox?: OutboxEventsRepository | null;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /** 53-14: `WEB_PUBLIC_URL`, for the link on a mirrored due date. */
  readonly webPublicUrl?: string;
}

/** The additional data binding a stored refresh token to its organization, person and provider. */
export function microsoftCalendarTokenBinding(
  organizationId: string,
  userId: string,
): { userId: string } {
  return { userId: `calendar:${organizationId}:${userId}:microsoft` };
}

/** How far back, and ahead, a first (or reset) delta window reaches. */
export const DELTA_BACK_MS = 30 * 86_400_000;
export const DELTA_AHEAD_MS = 365 * 86_400_000;
const MAX_PAGES_PER_PULL = 20;
/** `calendar_connections.sync_cursor` is VARCHAR(2048); a longer link is not kept. */
const MAX_CURSOR_LENGTH = 2048;

type Live = CalendarConnectionRow & { refreshTokenEnc: string };

function conflict(detail: 'not_configured' | 'unreachable'): ApiError {
  const messages = {
    not_configured: 'Outlook calendar is not set up for TManage yet',
    unreachable: 'Outlook calendar is not reachable. Reconnect it in Connected apps',
  } as const;
  return new ApiError(409, 'conflict', messages[detail], [{ field: 'calendar', message: detail }]);
}

function errorCode(error: unknown): string {
  if (error instanceof MicrosoftCalendarGrantRevokedError) return 'revoked';
  if (error instanceof MicrosoftCalendarEventNotFoundError) return 'event_not_found';
  if (error instanceof RecurrenceUnsupportedError) return 'recurrence_unsupported';
  return 'unavailable';
}

const isLive = (row: CalendarConnectionRow | null | undefined): row is Live =>
  !!row && row.status === 'connected' && !!row.refreshTokenEnc;
const isLinked = (link: MeetingExternalEventRow | null | undefined) =>
  !!link?.externalEventId && link.syncStatus !== 'deleted';

export class MicrosoftCalendarService
  implements CalendarSyncPort, CalendarProviderAdapter, CalendarRemote
{
  readonly provider = MICROSOFT;
  readonly pushPath = PUSH_PATH_MICROSOFT;
  private readonly extras: CalendarSyncExtras;
  private readonly connections: MicrosoftCalendarRepository;
  private readonly meetings: MeetingsRepository;
  private readonly calendar: MeetingCalendarRepository;
  private readonly answerDeps: ApplyProviderAnswersDeps;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly deps: MicrosoftCalendarServiceDeps) {
    this.connections = deps.connections ?? new MicrosoftCalendarRepository();
    this.meetings = deps.meetings ?? new MeetingsRepository();
    this.calendar = deps.calendar ?? new MeetingCalendarRepository();
    this.answerDeps = {
      calendar: this.calendar,
      rsvps: deps.rsvps ?? new MeetingRsvpRepository(),
      outbox: deps.outbox === undefined ? new OutboxEventsRepository() : deps.outbox,
    };
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((line) => console.warn(line));
    this.extras = new CalendarSyncExtras(deps.database, {
      apiPublicUrl: deps.apiPublicUrl,
      webPublicUrl: deps.webPublicUrl ?? '',
      now: this.now,
      log: this.log,
    });
  }

  get redirectUri(): string {
    return `${this.deps.apiPublicUrl.replace(/\/+$/, '')}${MSCAL_CALLBACK_PATH}`;
  }

  // ── The caller's own connection ───────────────────────────────────────────

  async status(context: TenantContext): Promise<MicrosoftCalendarStatusView> {
    const row = await this.deps.database.read(context, (runner) =>
      this.connections.findFor(runner, context, context.userId, MICROSOFT),
    );
    return this.toStatus(row);
  }

  startConnect(
    context: TenantContext,
    organizationSlug: string,
  ): { readonly url: string; readonly flow: MicrosoftCalendarFlow } {
    const config = this.requireConfig();
    const flow = newMicrosoftCalendarFlow({
      organizationId: context.organizationId,
      organizationSlug,
      userId: context.userId,
    });
    return {
      url: microsoftCalendarAuthorizationUrl({ config, redirectUri: this.redirectUri, flow }),
      flow,
    };
  }

  /**
   * Finish connecting. The flow must have been started by this person in this organization and the
   * returned `state` must equal the cookie's — a code replayed into another browser, organization
   * or person is refused before Microsoft is called.
   */
  async completeConnect(
    context: TenantContext,
    flow: MicrosoftCalendarFlow | undefined,
    input: { code: unknown; state: unknown },
  ): Promise<MicrosoftCalendarStatusView> {
    const config = this.requireConfig();
    if (
      !flow ||
      flow.organizationId !== context.organizationId ||
      flow.userId !== context.userId ||
      !microsoftCalendarStateMatches(flow, input.state) ||
      typeof input.code !== 'string' ||
      input.code === '' ||
      input.code.length > 4096
    ) {
      throw new ApiError(400, 'validation_failed', 'The Microsoft sign-in could not be completed');
    }
    let tokens;
    try {
      tokens = await this.deps.transport.exchangeCode({
        config,
        code: input.code,
        redirectUri: this.redirectUri,
        verifier: flow.verifier,
      });
    } catch {
      throw conflict('unreachable');
    }
    if (!tokens.refreshToken) throw conflict('unreachable');
    if (tokens.scope !== null && !/calendars\.readwrite/i.test(tokens.scope)) {
      // The person (or their company's policy) did not grant calendar access.
      throw new ApiError(400, 'validation_failed', 'Microsoft did not grant calendar access', [
        { field: 'scope', message: 'calendar_not_granted' },
      ]);
    }
    const refreshTokenEnc = this.deps.cipher.encrypt(
      tokens.refreshToken,
      microsoftCalendarTokenBinding(context.organizationId, context.userId),
    );
    const row = await this.deps.database.transaction(context, async (tx) => {
      await this.connections.saveConnected(tx, context, MICROSOFT, {
        accountEmail: tokens.email,
        refreshTokenEnc,
        grantedScopes: tokens.scope,
      });
      const saved = await this.connections.findFor(tx, context, context.userId, MICROSOFT);
      await this.deps.audit.record(tx, context, {
        action: 'calendar_connection.connected',
        result: 'allowed',
        objectId: saved?.id ?? null,
        metadata: { provider: MICROSOFT },
      });
      return saved;
    });
    if (row) {
      this.tokens.set(row.id, {
        token: tokens.accessToken,
        expiresAt: this.now().getTime() + Math.max(tokens.expiresInSeconds - 60, 0) * 1000,
      });
    }
    return this.toStatus(row);
  }

  /** Disconnect: wipe the token (Microsoft has no revoke endpoint). Meetings keep their links. */
  async disconnect(context: TenantContext): Promise<MicrosoftCalendarStatusView> {
    const connection = await this.deps.database.read(context, (runner) =>
      this.connections.findFor(runner, context, context.userId, MICROSOFT),
    );
    if (!connection || connection.status === 'disconnected') return this.toStatus(connection);
    // 53-14: end the subscription and remove mirrored due dates while the grant still works.
    await this.extras.teardown(this, context, connection.id);
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
        metadata: { provider: MICROSOFT },
      });
      return this.connections.findFor(tx, context, context.userId, MICROSOFT);
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
        const organizer = meeting.createdByUserId;
        const connection = await this.connections.findFor(runner, context, organizer, MICROSOFT);
        const link = await this.calendar.findLink(runner, context, meetingId, MICROSOFT);
        const google = this.deps.googleConfigured
          ? {
              connection: await this.connections.findFor(runner, context, organizer, 'google'),
              link: await this.calendar.findLink(runner, context, meetingId, 'google'),
            }
          : null;
        const organizerEmail = await this.connections.userEmail(runner, organizer);
        return {
          meeting,
          connection,
          link,
          google,
          snapshot: await this.snapshot(runner, context, meeting, [
            organizerEmail,
            connection?.accountEmail ?? null,
          ]),
        };
      });
    } catch (error) {
      this.log(`[calendar] reading meeting ${meetingId} for Outlook push failed: ${String(error)}`);
      return;
    }
    if (!state) return;
    const { meeting, connection, link, google, snapshot } = state;
    if (!isLive(connection)) {
      if (link && link.syncStatus !== 'deleted') {
        await this.markLink(context, link, { syncStatus: 'error', lastErrorCode: 'not_connected' });
      }
      return;
    }
    const route = pushProviderFor({
      conference: meeting.conference,
      googleConnected: isLive(google?.connection),
      microsoftConnected: true,
      googleLinked: isLinked(google?.link),
      microsoftLinked: isLinked(link),
    });
    if (route !== MICROSOFT) return;
    const personal = isPersonalMicrosoftAccount(connection.accountEmail);
    try {
      const accessToken = await this.accessToken(context, connection);
      if (snapshot.cancelled) {
        if (link?.externalEventId) {
          await this.deps.transport.cancelEvent(accessToken, link.externalEventId);
          await this.markLink(context, link, {
            syncStatus: 'deleted',
            lastErrorCode: null,
            lastPushedAt: this.now(),
          });
        }
        return;
      }
      const body = toGraphEvent(snapshot, { personalAccount: personal });
      let event: GraphEvent;
      if (link?.externalEventId) {
        event = await this.deps.transport.updateEvent(accessToken, link.externalEventId, body);
      } else {
        // `transactionId` makes a retried create (a timeout after Graph saved it) idempotent.
        event = await this.deps.transport.createEvent(accessToken, {
          ...body,
          transactionId: meeting.id,
        });
        await this.attachFiles(accessToken, event.id, meeting.id, snapshotFiles(state), personal);
      }
      const joinUrl = event.joinUrl ?? link?.joinUrl ?? null;
      await this.deps.database.transaction(context, (tx) =>
        this.calendar.saveLink(tx, context, meetingId, MICROSOFT, {
          connectionId: connection.id,
          externalEventId: event.id,
          externalCalendarId: connection.calendarId,
          icalUid: event.iCalUId,
          joinUrl,
          htmlLink: event.webLink,
          externalVersion: event.changeKey,
          syncStatus: 'synced',
          // A Teams meeting Outlook gave no link for (a personal account without Teams).
          lastErrorCode: meeting.conference === 'teams' && !joinUrl ? 'no_video_link' : null,
          lastPushedAt: this.now(),
        }),
      );
    } catch (error) {
      await this.recordFailure(context, connection, error);
      try {
        await this.deps.database.transaction(context, (tx) =>
          this.calendar.saveLink(tx, context, meetingId, MICROSOFT, {
            connectionId: connection.id,
            syncStatus: 'error',
            lastErrorCode: errorCode(error),
          }),
        );
      } catch (inner) {
        this.log(`[calendar] recording Outlook failure for ${meetingId} failed: ${String(inner)}`);
      }
    }
  }

  /**
   * A TManage answer goes to Outlook — only through the person's OWN Outlook connection: their copy
   * of the invitation (found by its iCalendar uid) is accepted, declined or tentatively accepted,
   * and Outlook tells the organizer. Graph has no way for the organizer to set an attendee's answer,
   * so without the person's own connection the answer stays in TManage. Never throws.
   */
  async forwardRsvp(
    context: TenantContext,
    meetingId: string,
    userId: string,
    rsvp: StoredAttendeeRsvp,
  ): Promise<void> {
    if (!this.deps.config) return;
    const action = graphResponseAction(rsvp);
    if (!action) return;
    try {
      const state = await this.deps.database.read(context, async (runner) => {
        const link = await this.calendar.findLink(runner, context, meetingId, MICROSOFT);
        if (!isLinked(link) || !link?.icalUid) return null;
        return { link, own: await this.connections.findFor(runner, context, userId, MICROSOFT) };
      });
      if (!state || !isLive(state.own) || state.own.id === state.link.connectionId) return;
      const accessToken = await this.accessToken(context, state.own);
      const copy = await this.deps.transport.findByICalUid(accessToken, state.link.icalUid ?? '');
      if (copy) await this.deps.transport.respond(accessToken, copy.id, action);
    } catch (error) {
      this.log(
        `[calendar] forwarding an Outlook answer for ${meetingId} failed: ${errorCode(error)}`,
      );
    }
  }

  // ── Pull ──────────────────────────────────────────────────────────────────

  async pullMeeting(context: TenantContext, meetingId: string, maxAgeMs: number): Promise<void> {
    if (!this.deps.config) return;
    try {
      const state = await this.deps.database.read(context, async (runner) => {
        const link = await this.calendar.findLink(runner, context, meetingId, MICROSOFT);
        if (!isLinked(link) || !link) return null;
        const fresh =
          link.lastPulledAt && this.now().getTime() - link.lastPulledAt.getTime() < maxAgeMs;
        if (fresh) return null;
        return {
          link,
          connection: await this.connections.findById(runner, context, link.connectionId),
        };
      });
      if (!state || !isLive(state.connection) || !state.link.externalEventId) return;
      const accessToken = await this.accessToken(context, state.connection);
      const event = await this.readEvent(accessToken, state.link.externalEventId);
      await this.apply(context, state.link, event);
    } catch (error) {
      this.log(`[calendar] pulling Outlook meeting ${meetingId} failed: ${errorCode(error)}`);
    }
  }

  /**
   * The sync job's pass over one connection: `calendarView/delta` from the stored delta link (a
   * fresh window the first time, or after Graph expired the link), applied to the meetings this
   * connection organizes. A recurring meeting's instances are matched by their series id; events
   * TManage does not know are ignored.
   */
  async pullConnection(context: TenantContext, connectionId: string): Promise<PullOutcome> {
    if (!this.deps.config) return 'skipped';
    const connection = await this.deps.database.read(context, (runner) =>
      this.connections.findById(runner, context, connectionId),
    );
    if (!isLive(connection)) return 'skipped';
    try {
      const accessToken = await this.accessToken(context, connection);
      let cursor = connection.syncCursor;
      let next: string | null;
      try {
        next = await this.walk(context, connection, accessToken, cursor);
      } catch (error) {
        if (!(error instanceof MicrosoftCalendarDeltaExpiredError) || cursor === null) throw error;
        cursor = null;
        next = await this.walk(context, connection, accessToken, null);
      }
      const stored = next ?? cursor;
      await this.deps.database.transaction(context, (tx) =>
        this.connections.update(tx, context, connection.id, {
          syncCursor: stored && stored.length <= MAX_CURSOR_LENGTH ? stored : null,
          lastSyncedAt: this.now(),
          lastErrorCode: null,
          lastErrorAt: null,
        }),
      );
      return 'ok';
    } catch (error) {
      await this.recordFailure(context, connection, error);
      return 'failed';
    }
  }

  private async walk(
    context: TenantContext,
    connection: Live,
    accessToken: string,
    deltaLink: string | null,
  ): Promise<string | null> {
    const now = this.now().getTime();
    const from = new Date(now - DELTA_BACK_MS);
    const to = new Date(now + DELTA_AHEAD_MS);
    const seen = new Set<string>();
    let link = deltaLink;
    for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
      const result = await this.deps.transport.delta(accessToken, { link, from, to });
      for (const change of result.events) {
        const ids = [change.id, change.seriesMasterId].filter((v): v is string => !!v);
        let found: MeetingExternalEventRow | null = null;
        for (const id of ids) {
          found = await this.deps.database.read(context, (runner) =>
            this.calendar.findLinkByEvent(runner, context, connection.id, id),
          );
          if (found) break;
        }
        if (!found?.externalEventId || seen.has(found.id)) continue;
        seen.add(found.id);
        // A removed series (not one removed instance) is the meeting cancelled; otherwise the
        // delta entry may be partial, so the linked event itself is read in full.
        const event =
          change.removed && change.id === found.externalEventId
            ? cancelledEvent(found.externalEventId)
            : await this.readEvent(accessToken, found.externalEventId);
        await this.apply(context, found, event);
      }
      if (result.deltaLink) return result.deltaLink;
      if (!result.nextLink) return null;
      link = result.nextLink;
    }
    return null;
  }

  /** The organizer's event, or a cancelled stand-in when Outlook no longer has it. */
  private async readEvent(accessToken: string, eventId: string): Promise<GraphEvent> {
    try {
      return await this.deps.transport.getEvent(accessToken, eventId);
    } catch (error) {
      if (error instanceof MicrosoftCalendarEventNotFoundError) return cancelledEvent(eventId);
      throw error;
    }
  }

  /** Apply the organizer's copy of an event to the meeting it is linked to. */
  private async apply(
    context: TenantContext,
    link: MeetingExternalEventRow,
    event: GraphEvent,
  ): Promise<void> {
    await this.deps.database.transaction(context, async (tx) => {
      const meeting = await this.meetings.findById(tx, context, link.meetingId);
      if (!meeting) return;
      if (event.cancelled || event.removed) {
        if (!meeting.cancelledAt) {
          await this.meetings.update(tx, context, meeting.id, { cancelledAt: this.now() });
        }
        await this.calendar.patchLink(tx, context, link.id, {
          syncStatus: 'deleted',
          lastPulledAt: this.now(),
        });
        return;
      }
      // Fix 2026-11-09: the same rule as Google's pull (`provider-answers.ts`).
      await applyProviderAnswers(tx, context, this.answerDeps, {
        meeting,
        roster: await this.calendar.roster(tx, context, meeting.id),
        answers: event.attendees.map((attendee) => ({
          email: attendee.email,
          rsvp: rsvpFromGraph(attendee.response),
        })),
        provider: 'microsoft',
      });
      // Edits made in Outlook win when Outlook's copy is newer than TManage's.
      if (event.updated && event.updated.getTime() > meeting.updatedAt.getTime()) {
        const patch = editsFrom(meeting, asEditable(event));
        if (patch) await this.meetings.update(tx, context, meeting.id, patch);
      }
      await this.calendar.patchLink(tx, context, link.id, {
        externalVersion: event.changeKey,
        ...(event.joinUrl ? { joinUrl: event.joinUrl } : {}),
        ...(event.webLink ? { htmlLink: event.webLink } : {}),
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
  ): Promise<MeetingSnapshot & { readonly oneDriveFiles: readonly OneDriveFile[] }> {
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
      attachments: [],
      oneDriveFiles: attachments
        .filter((a) => a.provider === 'onedrive' && a.webUrl?.startsWith('https://'))
        .map((a) => ({ title: a.title, webUrl: a.webUrl as string })),
    };
  }

  /** OneDrive files as Outlook cloud attachments, on the first create only. Best effort. */
  private async attachFiles(
    accessToken: string,
    eventId: string,
    meetingId: string,
    files: readonly OneDriveFile[],
    personal: boolean,
  ): Promise<void> {
    for (const file of files) {
      try {
        await this.deps.transport.addAttachment(
          accessToken,
          eventId,
          referenceAttachment({ ...file, personalAccount: personal }),
        );
      } catch (error) {
        this.log(
          `[calendar] attaching a file to ${meetingId} in Outlook failed: ${errorCode(error)}`,
        );
      }
    }
  }

  private async accessToken(context: TenantContext, connection: Live): Promise<string> {
    const cached = this.tokens.get(connection.id);
    if (cached && cached.expiresAt > this.now().getTime()) return cached.token;
    const config = this.requireConfig();
    const binding = microsoftCalendarTokenBinding(context.organizationId, connection.userId);
    const refreshToken = this.deps.cipher.decrypt(connection.refreshTokenEnc, binding);
    const fresh = await this.deps.transport.refreshTokens({ config, refreshToken });
    // Microsoft rotates the refresh token: store the new one, or the next refresh fails.
    if (fresh.refreshToken && fresh.refreshToken !== refreshToken) {
      const refreshTokenEnc = this.deps.cipher.encrypt(fresh.refreshToken, binding);
      await this.deps.database.transaction(context, (tx) =>
        this.connections.update(tx, context, connection.id, { refreshTokenEnc }),
      );
      connection.refreshTokenEnc = refreshTokenEnc;
    }
    this.tokens.set(connection.id, {
      token: fresh.accessToken,
      expiresAt: this.now().getTime() + Math.max(fresh.expiresInSeconds - 60, 0) * 1000,
    });
    return fresh.accessToken;
  }

  /** A refused grant moves the connection to `error` ("Reconnect"); anything else is logged. */
  private async recordFailure(context: TenantContext, connection: Live, error: unknown) {
    this.log(`[calendar] Outlook call for connection ${connection.id} failed: ${errorCode(error)}`);
    if (!(error instanceof MicrosoftCalendarGrantRevokedError)) {
      await this.extras.noteError(context, connection.id, errorCode(error));
      return;
    }
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

  private requireConfig(): MicrosoftCalendarConfig {
    if (!this.deps.config) throw conflict('not_configured');
    return this.deps.config;
  }

  private toStatus(row: CalendarConnectionRow | null): MicrosoftCalendarStatusView {
    const status =
      !row || row.status === 'disconnected'
        ? 'not_connected'
        : row.status === 'error'
          ? 'error'
          : 'connected';
    return {
      configured: this.deps.config !== null,
      microsoft: {
        status,
        accountEmail: status === 'not_connected' ? null : (row?.accountEmail ?? null),
        connectedAt:
          status !== 'not_connected' && row?.connectedAt ? row.connectedAt.toISOString() : null,
        lastSyncedAt: row?.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
        // 53-14: a connected calendar's last problem shows too, until a pull succeeds.
        lastErrorCode: status === 'not_connected' ? null : (row?.lastErrorCode ?? null),
        ...healthOf(row, status !== 'not_connected'),
      },
    };
  }

  // ── 53-14: push subscription and due-date mirror calls (CalendarRemote) ──

  async openSession(context: TenantContext, connectionId: string): Promise<RemoteSession | null> {
    if (!this.deps.config) return null;
    const connection = await this.deps.database.read(context, (runner) =>
      this.connections.findById(runner, context, connectionId),
    );
    if (!isLive(connection)) return null;
    return { connection, accessToken: await this.accessToken(context, connection) };
  }

  async openPush(
    session: RemoteSession,
    input: { readonly channelId: string; readonly secret: string; readonly address: string },
  ): Promise<{
    readonly channelId: string;
    readonly resourceId: string | null;
    readonly expiresAt: Date;
  }> {
    const created = await this.deps.transport.createSubscription(session.accessToken, {
      notificationUrl: input.address,
      clientState: input.secret,
      expiresAt: new Date(this.now().getTime() + GRAPH_SUBSCRIPTION_TTL_MS),
    });
    // Graph names the subscription; its id is the channel id the webhook looks up.
    return { channelId: created.id, resourceId: null, expiresAt: created.expiresAt };
  }

  async renewPush(session: RemoteSession): Promise<Date | null> {
    const id = session.connection.watchChannelId;
    if (!id) return null;
    return this.deps.transport.renewSubscription(
      session.accessToken,
      id,
      new Date(this.now().getTime() + GRAPH_SUBSCRIPTION_TTL_MS),
    );
  }

  async closePush(session: RemoteSession): Promise<void> {
    const id = session.connection.watchChannelId;
    if (id) await this.deps.transport.deleteSubscription(session.accessToken, id);
  }

  async putAllDay(
    session: RemoteSession,
    eventId: string | null,
    event: AllDayEvent,
  ): Promise<string> {
    const body = {
      subject: event.title,
      body: { contentType: 'text', content: event.link },
      start: { dateTime: `${event.date}T00:00:00`, timeZone: 'UTC' },
      end: { dateTime: `${nextDay(event.date)}T00:00:00`, timeZone: 'UTC' },
      isAllDay: true,
      showAs: 'free',
      isReminderOn: false,
    };
    if (eventId) {
      try {
        return (await this.deps.transport.updateEvent(session.accessToken, eventId, body)).id;
      } catch (error) {
        // Deleted in Outlook by the person: write it again.
        if (!(error instanceof MicrosoftCalendarEventNotFoundError)) throw error;
      }
    }
    return (await this.deps.transport.createEvent(session.accessToken, body)).id;
  }

  async deleteEvent(session: RemoteSession, eventId: string): Promise<void> {
    await this.deps.transport.deleteEvent(session.accessToken, eventId);
  }
}

interface OneDriveFile {
  readonly title: string;
  readonly webUrl: string;
}

function snapshotFiles(state: {
  readonly snapshot: { readonly oneDriveFiles: readonly OneDriveFile[] };
}): readonly OneDriveFile[] {
  return state.snapshot.oneDriveFiles;
}

function cancelledEvent(id: string): GraphEvent {
  return {
    id,
    seriesMasterId: null,
    removed: true,
    cancelled: true,
    changeKey: null,
    updated: null,
    webLink: null,
    iCalUId: null,
    joinUrl: null,
    subject: null,
    description: null,
    location: null,
    isAllDay: false,
    startsAt: null,
    endsAt: null,
    attendees: [],
  };
}

/** The fields {@link editsFrom} compares, read from an Outlook event. */
function asEditable(event: GraphEvent): GoogleEvent {
  return {
    id: event.id,
    status: event.cancelled ? 'cancelled' : 'confirmed',
    etag: event.changeKey,
    updated: event.updated,
    htmlLink: event.webLink,
    iCalUID: event.iCalUId,
    joinUrl: event.joinUrl,
    summary: event.subject,
    description: event.description === null ? null : withoutTeamsBlock(event.description),
    location: event.location,
    startsAt: event.isAllDay ? null : event.startsAt,
    endsAt: event.isAllDay ? null : event.endsAt,
    attendees: [],
    rawAttendees: [],
  };
}

/**
 * Outlook appends the Teams join block to a Teams meeting's body, under a line of underscores.
 * What comes before it is the agenda note TManage sent.
 */
export function withoutTeamsBlock(description: string): string {
  const cut = description.search(/_{10,}/);
  return (cut === -1 ? description : description.slice(0, cut)).trim();
}
