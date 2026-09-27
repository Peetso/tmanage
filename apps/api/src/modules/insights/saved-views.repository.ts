import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightSavedViews } from '../../common/database/schema.js';
import type {
  InsightReportKind,
  InsightSavedViewRow,
  InsightViewFilters,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** The fields a create carries. `ownerUserId` is the service's (`context.userId`), never the body's. */
export interface InsightSavedViewInsert {
  readonly name: string;
  readonly reportKind: InsightReportKind;
  readonly filters: InsightViewFilters;
}

/**
 * INS saved views (x210) — the create/list/delete store for a member's own named insights views.
 *
 * Every method is scoped by `(organization_id, owner_user_id)`: a view is private to its creator, so
 * there is no method that returns another user's views and no method without an owner in its
 * predicate — the same shape `a11y.repository.ts` takes for its per-member store. The queries run
 * under the tenant runner, so the layer-3 guard sees the `organization_id` predicate on every
 * statement.
 */
export class InsightSavedViewsRepository {
  /** Insert a view owned by `context.userId` and return its id. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsightSavedViewInsert,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(insightSavedViews)
      .values({
        id,
        organizationId: context.organizationId,
        ownerUserId: context.userId,
        name: input.name,
        reportKind: input.reportKind,
        filters: input.filters,
        createdAt: sql`current_timestamp(3)`,
      });
    return id;
  }

  /** One view by id, scoped to the acting user — the read-back after a create. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InsightSavedViewRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(insightSavedViews)
      .where(
        and(
          eq(insightSavedViews.organizationId, context.organizationId),
          eq(insightSavedViews.ownerUserId, context.userId),
          eq(insightSavedViews.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The acting user's views in this studio, in id order (uuidv7 being time-ordered). */
  async listOwn(runner: TenantQueryRunner, context: TenantContext): Promise<InsightSavedViewRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(insightSavedViews)
      .where(
        and(
          eq(insightSavedViews.organizationId, context.organizationId),
          eq(insightSavedViews.ownerUserId, context.userId),
        ),
      )
      .orderBy(asc(insightSavedViews.id));
  }

  /**
   * Delete a view by id, scoped to the acting user. Returns whether a row was removed: an id that
   * names another user's view (or no view) removes nothing and returns `false`.
   */
  async deleteOwn(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(insightSavedViews)
      .where(
        and(
          eq(insightSavedViews.organizationId, context.organizationId),
          eq(insightSavedViews.ownerUserId, context.userId),
          eq(insightSavedViews.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
