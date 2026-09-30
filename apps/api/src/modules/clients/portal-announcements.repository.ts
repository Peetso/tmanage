import { and, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { portalAnnouncements } from '../../common/database/schema.js';
import type { PortalAnnouncementRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * POR client portal (x304) — the storage half. Tenant- and client-scoped, following
 * `ProjectUpdateCommentsRepository` (0084) and `DocBookmarksRepository` (0114): `TenantContext` is the
 * scoping parameter on every method, there is no `organizationId` on any input (it comes from the
 * context), and every read and write is bound to `(organization_id, …)` so a caller in the wrong
 * tenant sees nothing. The repository holds no policy — the service decides who may read or write —
 * and offers only insert, delete and scoped reads, mirroring the withheld UPDATE privilege in
 * `users.sql`.
 */

/** The largest active-banner page a single portal read returns; mirrors the bounded reads elsewhere. */
export const MAX_PORTAL_ANNOUNCEMENT_PAGE = 200;

/** The insert shape. Note the absence of `organizationId` — it comes from the context. */
export interface CreatePortalAnnouncementInput {
  readonly clientId: string;
  readonly title: string;
  readonly body: string;
  /** When the banner goes live. The service supplies "now" when the caller omits one. */
  readonly startsAt: Date;
  /** `null` means open-ended. */
  readonly endsAt: Date | null;
  readonly createdBy: string;
}

export class PortalAnnouncementsRepository {
  /**
   * One client's banners that are active at `now` — `starts_at <= now` and (`ends_at` null or in the
   * future) — newest window first, bounded to one page. Tenant- and client-scoped.
   */
  async listActiveForClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientId: string,
    now: Date,
  ): Promise<readonly PortalAnnouncementRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(portalAnnouncements)
      .where(
        and(
          eq(portalAnnouncements.organizationId, context.organizationId),
          eq(portalAnnouncements.clientId, clientId),
          lte(portalAnnouncements.startsAt, now),
          or(isNull(portalAnnouncements.endsAt), gt(portalAnnouncements.endsAt, now)),
        ),
      )
      .orderBy(desc(portalAnnouncements.startsAt), desc(portalAnnouncements.id))
      .limit(MAX_PORTAL_ANNOUNCEMENT_PAGE);
  }

  /** One banner, scoped to the tenant and its client organization; `null` if absent. */
  async findForClient(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientId: string,
    announcementId: string,
  ): Promise<PortalAnnouncementRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(portalAnnouncements)
      .where(
        and(
          eq(portalAnnouncements.organizationId, context.organizationId),
          eq(portalAnnouncements.clientId, clientId),
          eq(portalAnnouncements.id, announcementId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Post a banner. `organization_id` comes from the context, never `input`. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreatePortalAnnouncementInput,
  ): Promise<PortalAnnouncementRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(portalAnnouncements)
      .values({
        id,
        organizationId: context.organizationId,
        clientId: input.clientId,
        title: input.title,
        body: input.body,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries any server-generated timestamp.
    const created = await this.findForClient(runner, context, input.clientId, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('portal announcement vanished immediately after insert');
    }
    return created;
  }

  /**
   * Delete one banner, scoped to the tenant and its client organization. Returns whether a row was
   * removed, so the service can stay idempotent (a repeated delete is still success).
   */
  async delete(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientId: string,
    announcementId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(portalAnnouncements)
      .where(
        and(
          eq(portalAnnouncements.organizationId, context.organizationId),
          eq(portalAnnouncements.clientId, clientId),
          eq(portalAnnouncements.id, announcementId),
        ),
      );

    return result[0].affectedRows > 0;
  }
}
