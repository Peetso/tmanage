import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { notifications } from '../../common/database/schema.js';
import type { NotificationRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The read half of NOTIF-001's table — INBOX-001's first half.
 *
 * The worker writes these rows (`apps/worker/src/common/database/notifications-store.ts`);
 * this repository only ever reads them and marks them read. Two rules, both enforced by the
 * shape of the methods rather than by a check a caller could forget:
 *
 * - **Every query names a recipient.** There is no `list(context)` that returns a tenant's
 *   notifications. `21-REQUIREMENTS-TRACEABILITY` FR-07 puts the whole authorization rule in
 *   two words — "recipient only" — and a method without a `recipientUserId` parameter would be
 *   the one place that rule could be dropped.
 * - **A row is read forward only.** `0010_notifications.sql`'s trigger refuses every change
 *   except `read_at` going from `NULL` to a time, and {@link markRead} writes only where
 *   `read_at IS NULL`, so a redelivered "mark read" is a no-op rather than a trigger error.
 *
 * ## The cursor runs backwards
 *
 * An inbox is read newest first. Ids are UUIDv7, so id order is creation order, and the
 * keyset cursor here is `id < before` rather than `id > after`: a page ends at its oldest
 * row and the next page starts below it.
 */

export interface ListNotificationsOptions {
  /** Keyset cursor: rows with an id below this one. Omitted, the newest rows. */
  readonly before?: string;
  readonly limit?: number;
  readonly unreadOnly?: boolean;
}

export const DEFAULT_NOTIFICATION_PAGE = 100;
export const MAX_NOTIFICATION_PAGE = 200;

export class NotificationsRepository {
  async listForRecipient(
    runner: TenantQueryRunner,
    context: TenantContext,
    recipientUserId: string,
    options: ListNotificationsOptions = {},
  ): Promise<readonly NotificationRow[]> {
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_NOTIFICATION_PAGE, 1),
      MAX_NOTIFICATION_PAGE,
    );
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
   * Mark the recipient's rows about one object as read. Returns how many actually changed.
   *
   * Scoped three ways — organization, recipient, object — so a caller who knows another
   * person's object id changes nothing of theirs. Rows already read are left alone; the
   * trigger would refuse a second write of `read_at` anyway, and a repeat is not an error.
   */
  async markRead(
    runner: TenantQueryRunner,
    context: TenantContext,
    recipientUserId: string,
    object: { readonly objectType: string; readonly objectId: string },
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(notifications)
      .set({ readAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(notifications.organizationId, context.organizationId),
          eq(notifications.recipientUserId, recipientUserId),
          eq(notifications.objectType, object.objectType),
          eq(notifications.objectId, object.objectId),
          isNull(notifications.readAt),
        ),
      );
    return result[0].affectedRows;
  }
}
