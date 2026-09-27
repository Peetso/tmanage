import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { orgAnnouncements } from '../../common/database/schema.js';
import type { OrgAnnouncementRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Org-wide admin announcement banners (Administration module 18, x276) — the tenant-scoped store behind
 * `org_announcements`. It owns the announcement insert, the delete, the single-row resolve used by the
 * DELETE path, and the newest-last list an org's members read. It follows the `doc_bookmarks` repository
 * (x242) pattern and honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and the
 *    `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateAnnouncementInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes resolve-then-delete on one connection
 * inside the transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (it comes from the context). */
export interface CreateAnnouncementInput {
  readonly title: string;
  readonly body: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  /** The posting membership — the service passes `context.membershipId`. */
  readonly createdBy: string;
}

/** A membership's announcement list is bounded — an org shows a handful of banners, not thousands. */
const MAX_ANNOUNCEMENTS_LISTED = 200;

export class OrgAnnouncementsRepository {
  /** Fetch one announcement by id, scoped to the acting tenant, or null (used before DELETE). */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<OrgAnnouncementRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(orgAnnouncements)
      .where(
        and(
          eq(orgAnnouncements.organizationId, context.organizationId),
          eq(orgAnnouncements.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insert a new announcement for the acting tenant and return the stored row. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateAnnouncementInput,
  ): Promise<OrgAnnouncementRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(orgAnnouncements).values({
      id,
      organizationId: context.organizationId,
      title: input.title,
      body: input.body,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdBy: input.createdBy,
      createdAt: new Date(),
    });
    const inserted = await this.findById(runner, context, id);
    return inserted as OrgAnnouncementRow;
  }

  /** Remove an announcement by id, scoped to the acting tenant. Idempotent (no row → no-op). */
  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(orgAnnouncements)
      .where(
        and(
          eq(orgAnnouncements.organizationId, context.organizationId),
          eq(orgAnnouncements.id, id),
        ),
      );
  }

  /** List the acting tenant's announcements, oldest first, bounded. Active-window filtering is the service's. */
  async listForOrg(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OrgAnnouncementRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(orgAnnouncements)
      .where(eq(orgAnnouncements.organizationId, context.organizationId))
      .orderBy(asc(orgAnnouncements.createdAt), asc(orgAnnouncements.id))
      .limit(MAX_ANNOUNCEMENTS_LISTED);
  }
}
