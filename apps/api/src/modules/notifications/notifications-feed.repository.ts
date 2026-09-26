import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { notifications } from '../../common/database/schema.js';
import type { NotificationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The notifications **feed** repository — NOTIF feed (x151).
 *
 * The audit carried Notifications as *Partial*: `notification-preferences` (NOTIF-001) ships,
 * and the bundled {@link InboxService} reads NOTIF-001's rows grouped by object, but there was
 * no flat per-notification feed a person could read and mark a single item read on. This
 * repository is that read half: it reads the acting person's own {@link notifications} rows
 * (0010) and marks one read by its id. It adds no table — 0010 exists — and, like
 * {@link NotificationsRepository}, only ever reads and marks rows read; the worker writes them.
 *
 * Two rules, both the shape of the methods rather than a check a caller could forget:
 *
 * - **Every query names a recipient.** `21-REQUIREMENTS-TRACEABILITY` FR-07 is "recipient
 *   only": there is no method without a `recipientUserId` parameter, so a tenant-wide read is
 *   not expressible here. That is the own-principal scope the feed's mark-read leans on — a
 *   caller who knows another person's `notificationId` resolves nothing, because the resolve
 *   names *their* recipient id, not the id in the path.
 * - **A row is read forward only.** `0010_notifications.sql`'s trigger refuses every change
 *   except `read_at` going from `NULL` to a time, and {@link markRead} writes only where
 *   `read_at IS NULL`, so a redelivered "mark read" is a no-op rather than a trigger error.
 *
 * The feed reads newest first. Ids are UUIDv7, so id order is creation order (`created_at`
 * descending), and the keyset cursor is `id < before`: a page ends at its oldest row and the
 * next page starts below it. `ix_notifications_recipient_id` (0014) is the index that makes
 * this read cheap. `25-AUTHORIZATION-…` §6 is honoured structurally: the first two parameters
 * are the runner and the context, the tenant comes from the context and never a DTO, and the
 * `organization_id` predicate is on every statement.
 */

/**
 * Injection token for {@link NotificationsFeedRepository}. Declared beside the class it
 * provides (the convention {@link MeetingAgendaRepository} follows) to keep this slice
 * file-disjoint from the shared `common/http/tokens.ts` append point.
 */
export const NOTIFICATIONS_FEED_REPOSITORY = Symbol('NOTIFICATIONS_FEED_REPOSITORY');

/** A bounded page — a feed is a window over the newest rows, not a whole-recipient export. */
export const DEFAULT_FEED_PAGE = 50;
export const MAX_FEED_PAGE = 200;

export interface ListFeedOptions {
  /** Keyset cursor: rows with an id below this one. Omitted, the newest rows. */
  readonly before?: string;
  readonly limit?: number;
  /** Only rows not yet read. Omitted or false, both read and unread. */
  readonly unreadOnly?: boolean;
}

/** Clamp a requested page size into `[1, MAX_FEED_PAGE]`, defaulting when absent. */
export function clampFeedLimit(limit?: number): number {
  return Math.min(Math.max(limit ?? DEFAULT_FEED_PAGE, 1), MAX_FEED_PAGE);
}

export class NotificationsFeedRepository {
  /**
   * One page of the recipient's own notifications, newest first. `unreadOnly` is a predicate
   * in the query, not a post-filter, so a page of `limit` rows is a page of `limit` matching
   * rows and the cursor never sits beneath a filtered-away tail.
   */
  async listForRecipient(
    runner: TenantQueryRunner,
    context: TenantContext,
    recipientUserId: string,
    options: ListFeedOptions = {},
  ): Promise<readonly NotificationRow[]> {
    const limit = clampFeedLimit(options.limit);
    const predicates = [
      eq(notifications.organizationId, context.organizationId),
      eq(notifications.recipientUserId, recipientUserId),
    ];
    if (options.before) predicates.push(lt(notifications.id, options.before));
    if (options.unreadOnly) predicates.push(isNull(notifications.readAt));

    return tenantDrizzle(runner)
      .select()
      .from(notifications)
      .where(and(...predicates))
      .orderBy(desc(notifications.id))
      .limit(limit);
  }

  /**
   * The recipient's own notification by id, or `undefined` when there is none of theirs with
   * that id. This is the mark-read resolve, run **before** any write: another person's (or
   * another tenant's) `notificationId` resolves to `undefined` here, because the query names
   * this recipient and this organization, so the caller never learns it exists and nothing is
   * written.
   */
  async findForRecipient(
    runner: TenantQueryRunner,
    context: TenantContext,
    recipientUserId: string,
    notificationId: string,
  ): Promise<NotificationRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.organizationId, context.organizationId),
          eq(notifications.recipientUserId, recipientUserId),
          eq(notifications.id, notificationId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * Mark the recipient's own notification read, returning how many rows changed. Scoped three
   * ways — organization, recipient, id — and only where `read_at IS NULL`, so a second call is
   * a no-op the trigger never has to refuse.
   */
  async markRead(
    runner: TenantQueryRunner,
    context: TenantContext,
    recipientUserId: string,
    notificationId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(notifications)
      .set({ readAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(notifications.organizationId, context.organizationId),
          eq(notifications.recipientUserId, recipientUserId),
          eq(notifications.id, notificationId),
          isNull(notifications.readAt),
        ),
      );
    return result[0].affectedRows;
  }
}
