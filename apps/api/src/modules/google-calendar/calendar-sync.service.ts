import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { CalendarFeedTokenRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { serializeCalendarIcs } from '../calendar/meeting-ics.js';
import type { IcsEvent } from '../calendar/meeting-ics.js';
import { GoogleCalendarRepository } from './google-calendar.repository.js';
import type { ConnectionRef } from './google-calendar.repository.js';
import { CalendarFeedTokensRepository } from './calendar-sync.repository.js';
import { CalendarMemberReader } from './calendar-member.js';
import {
  FEED_PATH,
  feedSecretFrom,
  googleNotificationValid,
  hashSecret,
  newSecret,
  readGoogleNotification,
  readGraphNotifications,
  secretMatches,
} from './calendar-push.js';

/**
 * 53-14 — the two signed-out doors of calendar sync and the feed settings behind them.
 *
 * - {@link CalendarPushReceiver}: a provider's push notification names a channel; the connection
 *   is found by that id alone (bootstrap read), the secret is proved against the stored hash, and
 *   only then is that one connection pulled. Nothing in the request is trusted beyond the id.
 * - {@link CalendarFeedService}: a person's secret feed address (random, hash stored, rotatable,
 *   revocable) and the read-only feed itself — the person's own open dated work and meetings,
 *   each row authorized with their own principal, re-resolved on every fetch.
 */

export const CALENDAR_PUSH_REASON =
  'finding the calendar connection a provider push notification names, by its channel id, ' +
  'before its secret is checked (53-14 calendar push)';
export const CALENDAR_FEED_REASON =
  'finding whose calendar feed a secret address opens, by the hash of the address, before the ' +
  'person is resolved like a request of theirs (53-14 ICS feed)';

export interface PushTarget {
  pullSoon(ref: ConnectionRef): Promise<void>;
}

type Headers = Readonly<Record<string, string | string[] | undefined>>;

export class CalendarPushReceiver {
  constructor(
    private readonly database: TenantDatabase,
    private readonly target: PushTarget,
    private readonly connections: GoogleCalendarRepository = new GoogleCalendarRepository(),
  ) {}

  /** A Google push request: 204 when verified (and pulled unless it is the `sync` hello), else 401. */
  async google(headers: Headers, correlationId: string): Promise<number> {
    const notification = readGoogleNotification(headers);
    if (!notification) return 401;
    const ref = await this.find(notification.channelId, correlationId);
    if (!ref || ref.provider !== 'google' || !googleNotificationValid(ref, notification)) {
      return 401;
    }
    if (notification.state !== 'sync') void this.target.pullSoon(ref);
    return 204;
  }

  /** A Graph notification batch: each entry is checked on its own; Graph is always answered 202. */
  async microsoft(body: unknown, correlationId: string): Promise<number> {
    const seen = new Set<string>();
    for (const entry of readGraphNotifications(body)) {
      if (seen.has(entry.subscriptionId)) continue;
      seen.add(entry.subscriptionId);
      const ref = await this.find(entry.subscriptionId, correlationId);
      if (!ref || ref.provider !== 'microsoft') continue;
      if (!secretMatches(ref.watchTokenHash, entry.clientState)) continue;
      void this.target.pullSoon(ref);
    }
    return 202;
  }

  private find(channelId: string, correlationId: string) {
    return this.database.bootstrapRead(
      { correlationId, reason: CALENDAR_PUSH_REASON, tables: ['calendar_connections'] },
      (db) => this.connections.findByWatchChannel(db, channelId),
    );
  }
}

/** `GET …/calendar-sync/feed`: whether the person has a feed address, never the address. */
export interface CalendarFeedView {
  readonly active: boolean;
  readonly createdAt: string | null;
  readonly lastUsedAt: string | null;
}

/** `POST …/calendar-sync/feed`: the new address, shown once. */
export interface CalendarFeedCreatedView extends CalendarFeedView {
  readonly url: string;
}

/** How far back and ahead the feed reaches, and how stale `last_used_at` may get. */
const FEED_BACK_MS = 30 * 86_400_000;
const FEED_AHEAD_MS = 365 * 86_400_000;
const TOUCH_EVERY_MS = 3_600_000;
const MEETING_DEFAULT_MS = 60 * 60_000;

export class CalendarFeedService {
  private readonly now: () => Date;

  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: AuditService,
    private readonly urls: { readonly apiPublicUrl: string; readonly webPublicUrl: string },
    private readonly tokens: CalendarFeedTokensRepository = new CalendarFeedTokensRepository(),
    private readonly members: CalendarMemberReader = new CalendarMemberReader(database),
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async status(context: TenantContext): Promise<CalendarFeedView> {
    const row = await this.database.read(context, (runner) => this.tokens.findOwn(runner, context));
    return feedView(row);
  }

  /** Create the caller's feed address, or replace it: the old address stops working at once. */
  async rotate(context: TenantContext): Promise<CalendarFeedCreatedView> {
    if (context.principalKind !== 'internal') {
      throw new ApiError(403, 'forbidden', 'Calendar feeds are for team members');
    }
    const secret = newSecret();
    const row = await this.database.transaction(context, async (tx) => {
      const before = await this.tokens.findOwn(tx, context);
      await this.tokens.saveOwn(tx, context, hashSecret(secret));
      const saved = await this.tokens.findOwn(tx, context);
      await this.audit.record(tx, context, {
        action: 'calendar_feed.issued',
        result: 'allowed',
        objectId: saved?.id ?? null,
        metadata: { replaced: before !== null },
      });
      return saved;
    });
    const base = this.urls.apiPublicUrl.replace(/\/+$/, '');
    return { ...feedView(row), url: `${base}${FEED_PATH}/${secret}/tmanage.ics` };
  }

  async revoke(context: TenantContext): Promise<CalendarFeedView> {
    await this.database.transaction(context, async (tx) => {
      const before = await this.tokens.findOwn(tx, context);
      if (!before) return;
      await this.tokens.deleteOwn(tx, context);
      await this.audit.record(tx, context, {
        action: 'calendar_feed.revoked',
        result: 'allowed',
        objectId: before.id,
        metadata: {},
      });
    });
    return feedView(null);
  }

  /**
   * The feed document for a presented address, or `null` (the route answers 404) when the address
   * is malformed, unknown, revoked, or its person may no longer have a calendar here.
   */
  async render(rawToken: unknown, correlationId: string): Promise<string | null> {
    const secret = feedSecretFrom(rawToken);
    if (!secret) return null;
    const owner = await this.database.bootstrapRead(
      { correlationId, reason: CALENDAR_FEED_REASON, tables: ['calendar_feed_tokens'] },
      (db) => this.tokens.findByHash(db, hashSecret(secret)),
    );
    if (!owner) return null;
    const member = await this.members.resolve({
      organizationId: owner.organizationId,
      userId: owner.userId,
      correlationId,
    });
    if (!member) return null;
    const stamp = this.now();
    const { due, meetings } = await this.members.items(member, {
      from: new Date(stamp.getTime() - FEED_BACK_MS),
      to: new Date(stamp.getTime() + FEED_AHEAD_MS),
      withMeetings: true,
    });
    await this.touch(member.context, owner.id, stamp);
    const web = this.urls.webPublicUrl.replace(/\/+$/, '');
    const slug = encodeURIComponent(member.orgSlug);
    const events: IcsEvent[] = [
      ...due.flatMap((item): IcsEvent[] =>
        item.dueAt
          ? [
              {
                kind: 'all_day',
                uid: `due-${item.id}@tmanage`,
                summary: item.title,
                date: item.dueAt.toISOString().slice(0, 10),
                url: `${web}/${slug}/work/${item.id}`,
              },
            ]
          : [],
      ),
      ...meetings.map((meeting): IcsEvent =>
        meeting.allDay
          ? {
              kind: 'all_day',
              uid: `${meeting.id}@tmanage`,
              summary: meeting.title,
              date: meeting.startsAt.toISOString().slice(0, 10),
            }
          : {
              uid: `${meeting.id}@tmanage`,
              summary: meeting.title,
              startsAt: meeting.startsAt,
              endsAt: meeting.endsAt ?? new Date(meeting.startsAt.getTime() + MEETING_DEFAULT_MS),
              ...(meeting.location ? { description: meeting.location } : {}),
            },
      ),
    ];
    return serializeCalendarIcs({ name: 'TManage', events, stamp });
  }

  /** `last_used_at`, at most once an hour (calendar apps fetch a feed every few minutes). */
  private async touch(context: TenantContext, id: string, at: Date): Promise<void> {
    const row = await this.database.read(context, (runner) => this.tokens.findOwn(runner, context));
    if (row?.lastUsedAt && at.getTime() - row.lastUsedAt.getTime() < TOUCH_EVERY_MS) return;
    await this.database.transaction(context, (tx) => this.tokens.touch(tx, context, id, at));
  }
}

function feedView(row: CalendarFeedTokenRow | null): CalendarFeedView {
  return {
    active: row !== null,
    createdAt: row?.createdAt ? row.createdAt.toISOString() : null,
    lastUsedAt: row?.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}
