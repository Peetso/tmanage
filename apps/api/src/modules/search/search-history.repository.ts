import { and, desc, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { searchHistory } from '../../common/database/schema.js';
import type { SearchHistoryRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Search recent history (x288) — the data half. One stateless repository over `search_history`.
 *
 * ## Every operation is scoped to one member in one studio
 *
 * A recent query is private: the owning member is the only reader and the only clearer. So every
 * method here carries both `organization_id = context.organizationId` AND
 * `membership_id = context.membershipId` predicates — the tenant boundary and the owner boundary
 * together. A cross-tenant read, or another member's row, simply does not match, so a member's list
 * only ever holds their own queries. There is no cross-member path.
 */
export class SearchHistoryRepository {
  /**
   * Record one query for the acting member: insert it, or, if the same normalised query already
   * exists for this member, refresh its `created_at` so the repeat moves to the front — never a
   * second row (the `(organization_id, membership_id, query)` unique key is the dedupe target).
   */
  async record(runner: TenantQueryRunner, context: TenantContext, query: string): Promise<void> {
    await tenantDrizzle(runner)
      .insert(searchHistory)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId: context.membershipId,
        query,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { createdAt: sql`current_timestamp(3)` } });
  }

  /**
   * Prune the acting member's history to the newest `keep` rows, deleting the rest by id. Called
   * after {@link record} so the list never grows past the retention cap. Tenant- and owner-scoped.
   */
  async prune(runner: TenantQueryRunner, context: TenantContext, keep: number): Promise<void> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ id: searchHistory.id })
      .from(searchHistory)
      .where(
        and(
          eq(searchHistory.organizationId, context.organizationId),
          eq(searchHistory.membershipId, context.membershipId),
        ),
      )
      .orderBy(desc(searchHistory.createdAt), desc(searchHistory.id));
    const stale = rows.slice(keep).map((row) => row.id);
    if (stale.length > 0) {
      await db
        .delete(searchHistory)
        .where(
          and(
            eq(searchHistory.organizationId, context.organizationId),
            eq(searchHistory.membershipId, context.membershipId),
            inArray(searchHistory.id, stale),
          ),
        );
    }
  }

  /** The acting member's recent queries, most-recent first, bounded to `limit`. */
  async listRecent(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number,
  ): Promise<readonly SearchHistoryRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(searchHistory)
      .where(
        and(
          eq(searchHistory.organizationId, context.organizationId),
          eq(searchHistory.membershipId, context.membershipId),
        ),
      )
      .orderBy(desc(searchHistory.createdAt), desc(searchHistory.id))
      .limit(limit);
  }

  /**
   * Clear the acting member's history — delete only their own rows in the acting studio. Scoped by
   * tenant and owner, so a clear never reaches another member's or another studio's rows.
   */
  async clear(runner: TenantQueryRunner, context: TenantContext): Promise<void> {
    await tenantDrizzle(runner)
      .delete(searchHistory)
      .where(
        and(
          eq(searchHistory.organizationId, context.organizationId),
          eq(searchHistory.membershipId, context.membershipId),
        ),
      );
  }
}
