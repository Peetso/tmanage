import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { NotificationRow } from '../../common/database/schema.js';
import { NOTIFICATIONS_FEED_REPOSITORY, clampFeedLimit } from './notifications-feed.repository.js';
import type { NotificationsFeedRepository } from './notifications-feed.repository.js';

/**
 * NOTIF feed (x151) — the flat, per-notification feed over NOTIF-001's rows (0010), behind
 * `work.read`.
 *
 * The audit carried Notifications as *Partial*: NOTIF-001 preferences ship, and the bundled
 * {@link InboxController} reads notifications grouped by object, but there was no feed a person
 * could read as a list and mark a *single* item read on — `22-SCREEN-BY-SCREEN` TM-27's feed
 * body. This slice adds `GET .../notifications` and `POST .../notifications/:id/read`.
 *
 * ## The capability, decided rather than invented
 *
 * `12-PERMISSION-MATRIX` names no notification capability, and NOTIF-001 / INBOX-001 both
 * recorded the choice: **`work.read`** — the one capability every internal role holds and no
 * client role does. Adding a `notification.read` would put a word in the ceiling table the
 * matrix does not have. The control that matters is not the coarse guard: the recipient is
 * `principal.userId`, set by the authenticated pipeline and nothing a request can name, so a
 * caller reads their own rows and marks their own rows read — never another person's, whatever
 * id they put in the path.
 *
 * ## Mark-read resolves before it writes
 *
 * `POST :notificationId/read` resolves the row **scoped to the acting recipient and tenant
 * first**, inside the transaction, and a miss is a 404 with no write — the resolve query names
 * this recipient, so another user's (or another tenant's) `notificationId` finds nothing and
 * the update never runs. That is the substance FR-07 puts in two words ("recipient only"), and
 * it is here in the resolve rather than in the guard, which is the coarse half only. A
 * malformed id — one this API never issued — is the same 404: it names no row either.
 *
 * The feed is intentionally flat where the inbox bundles: the inbox resolves each object's
 * title through its authorized read for a "what needs doing" surface; the feed is the raw
 * reference list a person scans and clears, so it echoes only the envelope (type, object
 * reference, read state, time) and resolves nothing. Per-kind opt-out is x152; real-time push
 * is NS-13.
 */

/** One notification on the feed — the reference envelope, never resolved content. */
export interface NotificationView {
  readonly id: string;
  /** The event type, e.g. `work_item.blocked.v1`. */
  readonly type: string;
  /** What the notification is about — `work_item`, `client_request`, `organization_usage`, … */
  readonly objectType: string;
  readonly objectId: string;
  /** Whether the recipient has read it — the unread-first flag the screen partitions on. */
  readonly read: boolean;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
  /** When it was read, or `null` while unread. */
  readonly readAt: string | null;
}

/**
 * A page of the recipient's feed — x151's `NotificationFeedView`, paired Exact with the web
 * shape `NotificationsFeedScreen` consumes (CONTRACT-001). `organizationId` is never echoed
 * (`25-AUTH…` §7): the caller already knows the tenant they asked about.
 */
export interface NotificationFeedView {
  readonly items: readonly NotificationView[];
  /** The id of the oldest row on this page, or `null` at the end of the feed. */
  readonly nextCursor: string | null;
}

@Controller('v1/organizations/:orgSlug/notifications')
export class NotificationsFeedController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(NOTIFICATIONS_FEED_REPOSITORY) private readonly feed: NotificationsFeedRepository,
  ) {}

  /**
   * One page of the acting recipient's own notifications, newest first. `unread=true` narrows
   * to the unread rows; `before` is a keyset cursor this API handed out; `limit` is clamped.
   * The recipient is `principal.userId` and nothing the request can name.
   */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('unread') unread?: string,
  ): Promise<NotificationFeedView> {
    const details: { field: string; message: string }[] = [];

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) {
      details.push({ field: 'limit', message: 'must be a positive integer' });
    }
    // A cursor is an id this API handed out; anything else compares as text and silently
    // returns some page, so it is refused rather than honoured.
    if (before !== undefined && !isUuid(before)) {
      details.push({ field: 'before', message: 'must be a cursor this API returned' });
    }
    if (unread !== undefined && unread !== 'true' && unread !== 'false') {
      details.push({ field: 'unread', message: 'must be true or false' });
    }
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', details);
    }

    const effectiveLimit = clampFeedLimit(parsedLimit);
    const rows = await this.database.read(context, (runner) =>
      this.feed.listForRecipient(runner, context, principal.userId, {
        limit: effectiveLimit,
        ...(before ? { before } : {}),
        ...(unread === 'true' ? { unreadOnly: true } : {}),
      }),
    );

    const oldest = rows[rows.length - 1];
    return {
      items: rows.map(toView),
      nextCursor: rows.length === effectiveLimit && oldest ? oldest.id : null,
    };
  }

  /**
   * Mark one of the recipient's own notifications read. The row is resolved scoped to this
   * recipient and tenant **before** the write; another user's or tenant's id — or one this API
   * never issued — is a 404 with no write. Idempotent: an already-read row is returned
   * unchanged rather than written a second time.
   */
  @Post(':notificationId/read')
  @RequireCapability('work.read')
  @HttpCode(200)
  async markRead(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('notificationId') notificationId: string,
  ): Promise<NotificationView> {
    if (!isUuid(notificationId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    return this.database.transaction(context, async (tx) => {
      const existing = await this.feed.findForRecipient(
        tx,
        context,
        principal.userId,
        notificationId,
      );
      if (!existing) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      if (existing.readAt === null) {
        await this.feed.markRead(tx, context, principal.userId, notificationId);
      }
      // Re-read so the returned `readAt` is the row's persisted value, not a clock guess.
      const row = await this.feed.findForRecipient(tx, context, principal.userId, notificationId);
      return toView(row ?? existing);
    });
  }
}

/** An explicit projection, not a serialised row (`25-AUTH…` §7): `organization_id` is never echoed. */
function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.type,
    objectType: row.objectType,
    objectId: row.objectId,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}
