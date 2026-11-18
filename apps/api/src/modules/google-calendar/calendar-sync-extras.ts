import { createHash } from 'node:crypto';
import { uuidv7 } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { CalendarConnectionRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import type { CalendarProvider } from './google-calendar.repository.js';
import {
  CalendarDueMirrorsRepository,
  MAX_MIRRORS_PER_CONNECTION,
} from './calendar-sync.repository.js';
import { CalendarMemberReader } from './calendar-member.js';
import { PUSH_RENEW_BEFORE_MS, hashSecret, newSecret, pushAddress } from './calendar-push.js';
import { PushBackoff } from './push-backoff.js';

/**
 * 53-14 — what the calendar sync does beyond the pull, for any provider that can:
 *
 * - **Push.** A connection gets a push channel (Google watch channel / Graph subscription) when
 *   the API is reachable over HTTPS; the job renews it a day before it ends and the webhook turns
 *   each notification into an immediate pull. Without one the minute poll goes on as before.
 * - **Due-date mirror.** When the person opted in, every open dated work item they may read
 *   appears in their calendar as an all-day event: written once, re-sent when its title or date
 *   changes, removed when it is done, deleted, moved out of reach or the person opts out.
 * - **Teardown** on disconnect, before the grant is revoked: the channel is stopped and every
 *   mirrored event removed.
 *
 * Every step is best effort and never throws to the job: a failure is logged (codes only) and
 * the next pass tries again.
 */

export interface RemoteSession {
  readonly connection: CalendarConnectionRow;
  readonly accessToken: string;
}

/** A due date as an all-day event: `date` is `YYYY-MM-DD`. */
export interface AllDayEvent {
  readonly title: string;
  readonly date: string;
  readonly link: string;
}

/** The provider calls the extras need; the Google and Microsoft services implement it. */
export interface CalendarRemote {
  readonly provider: string;
  /** The webhook path this provider's notifications arrive on. */
  readonly pushPath: string;
  /** The live connection and an access token, or `null` when it cannot be used now. */
  openSession(context: TenantContext, connectionId: string): Promise<RemoteSession | null>;
  openPush(
    session: RemoteSession,
    input: { readonly channelId: string; readonly secret: string; readonly address: string },
  ): Promise<{
    readonly channelId: string;
    readonly resourceId: string | null;
    readonly expiresAt: Date;
  }>;
  /** Extend the channel in place, or `null` when the provider needs a new one instead. */
  renewPush(session: RemoteSession): Promise<Date | null>;
  closePush(session: RemoteSession): Promise<void>;
  /** Write (or overwrite, when `eventId` is set) the all-day event; returns its event id. */
  putAllDay(session: RemoteSession, eventId: string | null, event: AllDayEvent): Promise<string>;
  deleteEvent(session: RemoteSession, eventId: string): Promise<void>;
}

/** 53-14. The health a connection card shows beyond its status and last sync. */
export interface CalendarHealthFields {
  /** When the last failed sync happened (`lastErrorCode` says what failed). */
  readonly lastErrorAt: string | null;
  /** When the provider ends the push channel; `null` when the calendar is polled each minute. */
  readonly pushExpiresAt: string | null;
  /** The person's opt-in: their work items' due dates as all-day events. */
  readonly mirrorDueDates: boolean;
}

export function healthOf(row: CalendarConnectionRow | null, live: boolean): CalendarHealthFields {
  return {
    lastErrorAt:
      live && row?.lastErrorCode && row.lastErrorAt ? row.lastErrorAt.toISOString() : null,
    pushExpiresAt:
      live && row?.watchChannelId && row.watchExpiresAt ? row.watchExpiresAt.toISOString() : null,
    mirrorDueDates: live && (row?.mirrorDueDates ?? false),
  };
}

/** The day after a `YYYY-MM-DD` date (an all-day event ends the next day). */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function isCalendarRemote(value: unknown): value is CalendarRemote {
  const v = value as Partial<CalendarRemote> | null;
  return typeof v?.openSession === 'function' && typeof v.putAllDay === 'function';
}

export interface CalendarSyncExtrasOptions {
  readonly apiPublicUrl: string;
  readonly webPublicUrl: string;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

/** How far back and ahead the mirror reaches. */
const MIRROR_BACK_MS = 7 * 86_400_000;
const MIRROR_AHEAD_MS = 365 * 86_400_000;

export function mirrorFingerprint(event: AllDayEvent): string {
  return createHash('sha256').update(`${event.date}\n${event.title}`, 'utf8').digest('hex');
}

export class CalendarSyncExtras {
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  /** LOGQUIET-c: a provider refusing the channel is asked again later, not every minute. */
  private readonly pushBackoff = new PushBackoff();

  constructor(
    private readonly database: TenantDatabase,
    private readonly options: CalendarSyncExtrasOptions,
    private readonly connections: GoogleCalendarRepository = new GoogleCalendarRepository(),
    private readonly mirrors: CalendarDueMirrorsRepository = new CalendarDueMirrorsRepository(),
    private readonly members: CalendarMemberReader = new CalendarMemberReader(database),
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((line) => console.warn(line));
  }

  /**
   * The caller's own opt-in to see their due dates in one connected calendar. The next pass of
   * the sync job writes (or removes) the events.
   */
  async setMirror(
    context: TenantContext,
    audit: AuditService,
    provider: CalendarProvider,
    enabled: boolean,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const connection = await this.connections.findFor(tx, context, context.userId, provider);
      if (!connection || connection.status === 'disconnected') {
        throw new ApiError(409, 'conflict', 'Connect this calendar first', [
          { field: 'calendar', message: 'not_connected' },
        ]);
      }
      await this.connections.update(tx, context, connection.id, { mirrorDueDates: enabled });
      await audit.record(tx, context, {
        action: 'calendar_connection.mirror_changed',
        result: 'allowed',
        objectId: connection.id,
        metadata: { provider, enabled },
      });
    });
  }

  /** A failure that is not a refused grant: the card's "last problem" until a pull works. */
  async noteError(context: TenantContext, connectionId: string, code: string): Promise<void> {
    try {
      await this.database.transaction(context, (tx) =>
        this.connections.update(tx, context, connectionId, {
          lastErrorCode: code,
          lastErrorAt: this.now(),
        }),
      );
    } catch (error) {
      this.log(`[calendar-sync] noting the error on ${connectionId} failed: ${errorName(error)}`);
    }
  }

  /** After a successful pull: keep the channel alive and the mirror in step. */
  async maintain(
    remote: CalendarRemote,
    context: TenantContext,
    connectionId: string,
  ): Promise<void> {
    let session: RemoteSession | null = null;
    try {
      session = await remote.openSession(context, connectionId);
    } catch (error) {
      this.log(`[calendar-sync] connection ${connectionId} not usable: ${errorName(error)}`);
      return;
    }
    if (!session) return;
    await this.keepPush(remote, context, session);
    await this.reconcileMirror(remote, context, session);
  }

  /** Before disconnecting: stop the channel and remove every mirrored event, then forget both. */
  async teardown(
    remote: CalendarRemote,
    context: TenantContext,
    connectionId: string,
  ): Promise<void> {
    try {
      const mirrored = await this.database.read(context, (runner) =>
        this.mirrors.list(runner, context, connectionId),
      );
      const connection = await this.database.read(context, (runner) =>
        this.connections.findById(runner, context, connectionId),
      );
      if (!connection) return;
      if (connection.watchChannelId || mirrored.length > 0) {
        const session = await remote.openSession(context, connectionId).catch(() => null);
        if (session) {
          if (connection.watchChannelId) await remote.closePush(session).catch(() => undefined);
          for (const row of mirrored) {
            await remote.deleteEvent(session, row.externalEventId).catch(() => undefined);
          }
        }
      }
      await this.database.transaction(context, async (tx) => {
        for (const row of mirrored) await this.mirrors.remove(tx, context, row.id);
        await this.connections.update(tx, context, connectionId, {
          ...NO_CHANNEL,
          mirrorDueDates: false,
        });
      });
    } catch (error) {
      this.log(`[calendar-sync] teardown of ${connectionId} failed: ${errorName(error)}`);
    }
  }

  private async keepPush(
    remote: CalendarRemote,
    context: TenantContext,
    session: RemoteSession,
  ): Promise<void> {
    const address = pushAddress(this.options.apiPublicUrl, remote.pushPath);
    if (!address) return;
    const { connection } = session;
    const now = this.now().getTime();
    const expires = connection.watchExpiresAt?.getTime() ?? 0;
    if (connection.watchChannelId && expires - now > PUSH_RENEW_BEFORE_MS) return;
    if (!this.pushBackoff.mayTry(connection.id, now)) return;
    try {
      if (connection.watchChannelId && expires > now) {
        const renewed = await remote.renewPush(session);
        if (renewed) {
          await this.database.transaction(context, (tx) =>
            this.connections.update(tx, context, connection.id, { watchExpiresAt: renewed }),
          );
          this.pushBackoff.succeeded(connection.id);
          return;
        }
      }
      const secret = newSecret();
      const opened = await remote.openPush(session, { channelId: uuidv7(), secret, address });
      // The new channel is stored first, so a notification on it is never refused; the old one
      // is stopped afterwards (its notifications fail verification from here on).
      await this.database.transaction(context, (tx) =>
        this.connections.update(tx, context, connection.id, {
          watchChannelId: opened.channelId,
          watchTokenHash: hashSecret(secret),
          watchResourceId: opened.resourceId,
          watchExpiresAt: opened.expiresAt,
        }),
      );
      this.pushBackoff.succeeded(connection.id);
      if (connection.watchChannelId) await remote.closePush(session).catch(() => undefined);
    } catch (error) {
      const waitMs = this.pushBackoff.failed(connection.id, now);
      if (waitMs !== null) {
        this.log(
          `[calendar-sync] push channel for ${connection.id} failed: ${errorName(error)}; ` +
            `next try in ${String(Math.round(waitMs / 60_000))} min`,
        );
      }
    }
  }

  private async reconcileMirror(
    remote: CalendarRemote,
    context: TenantContext,
    session: RemoteSession,
  ): Promise<void> {
    const { connection } = session;
    try {
      const mirrored = await this.database.read(context, (runner) =>
        this.mirrors.list(runner, context, connection.id),
      );
      if (!connection.mirrorDueDates && mirrored.length === 0) return;
      const wanted = new Map<string, AllDayEvent>();
      if (connection.mirrorDueDates) {
        const member = await this.members.resolve({
          organizationId: context.organizationId,
          userId: connection.userId,
          correlationId: context.correlationId,
        });
        if (member) {
          const now = this.now().getTime();
          const { due } = await this.members.items(member, {
            from: new Date(now - MIRROR_BACK_MS),
            to: new Date(now + MIRROR_AHEAD_MS),
            withMeetings: false,
          });
          const web = this.options.webPublicUrl.replace(/\/+$/, '');
          for (const item of due.slice(0, MAX_MIRRORS_PER_CONNECTION)) {
            if (!item.dueAt) continue;
            wanted.set(item.id, {
              title: item.title,
              date: item.dueAt.toISOString().slice(0, 10),
              link: `${web}/${encodeURIComponent(member.orgSlug)}/work/${item.id}`,
            });
          }
        }
      }
      const byItem = new Map(mirrored.map((row) => [row.workItemId, row]));
      for (const row of mirrored) {
        if (wanted.has(row.workItemId)) continue;
        await remote.deleteEvent(session, row.externalEventId);
        await this.database.transaction(context, (tx) => this.mirrors.remove(tx, context, row.id));
      }
      for (const [workItemId, event] of wanted) {
        const existing = byItem.get(workItemId);
        const fingerprint = mirrorFingerprint(event);
        if (existing?.fingerprint === fingerprint) continue;
        const externalEventId = await remote.putAllDay(
          session,
          existing?.externalEventId ?? null,
          event,
        );
        await this.database.transaction(context, (tx) =>
          this.mirrors.save(tx, context, {
            connectionId: connection.id,
            workItemId,
            externalEventId,
            fingerprint,
          }),
        );
      }
    } catch (error) {
      this.log(`[calendar-sync] due-date mirror for ${connection.id} failed: ${errorName(error)}`);
    }
  }
}

const NO_CHANNEL = {
  watchChannelId: null,
  watchTokenHash: null,
  watchResourceId: null,
  watchExpiresAt: null,
} as const;

/** A class name only: an error message from a provider may quote a token or an address. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
