import { and, asc, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { savedSearches, savedSearchShares } from '../../common/database/schema.js';
import type { SavedSearchFilter } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SRCH saved-search sharing (x272) — the data half. One stateless repository over
 * `saved_search_shares`, plus a **read-only** resolve of the owning `saved_searches` row.
 *
 * ## Every operation is scoped to one studio
 *
 * A share belongs to a studio, so every method here carries `organization_id =
 * context.organizationId`. The layer-3 tenant guard fails OPEN on an unregistered table, so the
 * `TENANT_TABLES` entry plus these predicates are what keep one studio's shares invisible to another.
 *
 * ## Soft read of `saved_searches`
 *
 * {@link resolveOwner} reads `saved_searches` by `(organization_id, id, kind='saved')` and returns
 * the owner's `user_id`, or `undefined` when the saved search does not exist in this studio. This is
 * the soft dependency on x214: no foreign key binds the tables, so the service turns an absent saved
 * search into a 404 and enforces the owner check against the returned `user_id`. There is no UPDATE:
 * a share is inserted (idempotent) and deleted, never edited.
 */
export class SavedSearchSharesRepository {
  /**
   * The owning `user_id` of one saved search in this studio, or `undefined` when no `'saved'` row
   * with that id exists here. Read-only — the sharing slice never writes `saved_searches`.
   */
  async resolveOwner(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedSearchId: string,
  ): Promise<string | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ ownerUserId: savedSearches.userId })
      .from(savedSearches)
      .where(
        and(
          eq(savedSearches.organizationId, context.organizationId),
          eq(savedSearches.kind, 'saved'),
          eq(savedSearches.id, savedSearchId),
        ),
      )
      .limit(1);
    return rows[0]?.ownerUserId;
  }

  /** Whether this saved search is already shared in this studio. */
  async isShared(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedSearchId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: savedSearchShares.id })
      .from(savedSearchShares)
      .where(
        and(
          eq(savedSearchShares.organizationId, context.organizationId),
          eq(savedSearchShares.savedSearchId, savedSearchId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Share a saved search with the studio, idempotently: a repeat share is a no-op (the
   * `(organization_id, saved_search_id)` unique key makes one share the only share). The owner has
   * already been resolved and authorized by the service before this runs.
   */
  async insertShareIfAbsent(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedSearchId: string,
  ): Promise<void> {
    if (await this.isShared(runner, context, savedSearchId)) return;
    await tenantDrizzle(runner)
      .insert(savedSearchShares)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        savedSearchId,
        sharedByMembershipId: context.membershipId,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /** Remove the share for one saved search in this studio. Returns whether a row was removed. */
  async deleteShare(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedSearchId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(savedSearchShares)
      .where(
        and(
          eq(savedSearchShares.organizationId, context.organizationId),
          eq(savedSearchShares.savedSearchId, savedSearchId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * The studio's shared saved searches, newest share first. Joins each share back to its
   * `saved_searches` row (read-only) for the name, query, filters and owner; a share whose saved
   * search has since vanished (no FK binds them) simply drops out of the inner join.
   */
  async listShared(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<
    readonly {
      readonly id: string;
      readonly name: string | null;
      readonly queryText: string;
      readonly filters: readonly SavedSearchFilter[];
      readonly ownerUserId: string;
      readonly sharedAt: Date;
    }[]
  > {
    return tenantDrizzle(runner)
      .select({
        id: savedSearches.id,
        name: savedSearches.name,
        queryText: savedSearches.queryText,
        filters: savedSearches.filters,
        ownerUserId: savedSearches.userId,
        sharedAt: savedSearchShares.createdAt,
      })
      .from(savedSearchShares)
      .innerJoin(
        savedSearches,
        and(
          eq(savedSearchShares.organizationId, savedSearches.organizationId),
          eq(savedSearchShares.savedSearchId, savedSearches.id),
        ),
      )
      .where(
        and(
          eq(savedSearchShares.organizationId, context.organizationId),
          eq(savedSearches.kind, 'saved'),
        ),
      )
      .orderBy(desc(savedSearchShares.createdAt), asc(savedSearchShares.savedSearchId));
  }
}
