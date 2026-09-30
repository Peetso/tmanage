import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightMetricFavorites } from '../../common/database/schema.js';
import type {
  InsightMetricFavoriteRow,
  InsightFavoriteMetricKey,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS metric favorites (x303) — a membership's private starred insight metrics. It owns the star
 * insert, the unstar delete, and the newest-first list of a membership's favorites. It follows the
 * `doc_bookmarks` repository (x242) pattern and honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AddFavoriteInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes check-then-insert on one connection
 * inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface AddFavoriteInput {
  /** The starring membership — the service passes `context.membershipId`. */
  readonly membershipId: string;
  /** A key already validated against the fixed allowlist by the controller. */
  readonly metricKey: InsightFavoriteMetricKey;
}

/** A membership's favorites list is bounded — the allowlist is small, but the query is capped regardless. */
const MAX_FAVORITES_LISTED = 200;

export class InsightMetricFavoritesRepository {
  /** Fetch one membership's favorite of one metric, scoped to the acting tenant, or null. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    metricKey: InsightFavoriteMetricKey,
  ): Promise<InsightMetricFavoriteRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(insightMetricFavorites)
      .where(
        and(
          eq(insightMetricFavorites.organizationId, context.organizationId),
          eq(insightMetricFavorites.membershipId, membershipId),
          eq(insightMetricFavorites.metricKey, metricKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Star a metric for a membership, idempotently. If the favorite already exists it is returned
   * unchanged (a repeated PUT is a no-op, never a second row and never an UPDATE — the grant withholds
   * UPDATE); otherwise a new row is inserted. The `(organization_id, membership_id, metric_key)`
   * unique key is the guard: a racing insert that collides is caught and the existing row re-read.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddFavoriteInput,
  ): Promise<InsightMetricFavoriteRow> {
    const existing = await this.find(runner, context, input.membershipId, input.metricKey);
    if (existing) {
      return existing;
    }

    const db = tenantDrizzle(runner);
    const id = uuidv7();
    try {
      await db.insert(insightMetricFavorites).values({
        id,
        organizationId: context.organizationId,
        membershipId: input.membershipId,
        metricKey: input.metricKey,
        createdAt: new Date(),
      });
    } catch (error) {
      // A concurrent PUT won the unique key first; the favorite now exists, so re-read it and treat
      // this call as the idempotent no-op it is. Any other error is a real failure — rethrow.
      const raced = await this.find(runner, context, input.membershipId, input.metricKey);
      if (raced) {
        return raced;
      }
      throw error;
    }

    const inserted = await this.find(runner, context, input.membershipId, input.metricKey);
    return inserted as InsightMetricFavoriteRow;
  }

  /** Remove a membership's favorite of a metric, scoped to the acting tenant. Idempotent (no row → no-op). */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    metricKey: InsightFavoriteMetricKey,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(insightMetricFavorites)
      .where(
        and(
          eq(insightMetricFavorites.organizationId, context.organizationId),
          eq(insightMetricFavorites.membershipId, membershipId),
          eq(insightMetricFavorites.metricKey, metricKey),
        ),
      );
  }

  /** List one membership's favorites, newest first, scoped to the acting tenant. Bounded. */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly InsightMetricFavoriteRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(insightMetricFavorites)
      .where(
        and(
          eq(insightMetricFavorites.organizationId, context.organizationId),
          eq(insightMetricFavorites.membershipId, membershipId),
        ),
      )
      .orderBy(desc(insightMetricFavorites.createdAt), desc(insightMetricFavorites.id))
      .limit(MAX_FAVORITES_LISTED);
  }
}
