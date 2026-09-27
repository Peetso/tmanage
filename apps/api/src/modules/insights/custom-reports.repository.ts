import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightCustomReports } from '../../common/database/schema.js';
import type {
  InsightCustomReportLayout,
  InsightCustomReportMetricKeys,
  InsightCustomReportRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The fields a create or replace carries. `ownerUserId` is the service's (`context.userId`), never the
 * body's; `metricKeys` and `layout` are validated against their allowlists in the controller.
 */
export interface InsightCustomReportInsert {
  readonly name: string;
  readonly metricKeys: InsightCustomReportMetricKeys;
  readonly layout: InsightCustomReportLayout;
}

/**
 * INS custom reports (x320) — the create/list/get/replace/delete store for a member's own composed
 * insight reports.
 *
 * Every method is scoped by `(organization_id, owner_user_id)`: a report is private to its creator, so
 * there is no method that returns another user's report and no method without an owner in its
 * predicate — the shape `saved-views.repository.ts` takes for its per-member store. The queries run
 * under the tenant runner, so the layer-3 guard sees the `organization_id` predicate on every
 * statement.
 */
export class InsightCustomReportsRepository {
  /** Insert a report owned by `context.userId` and return its id. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsightCustomReportInsert,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(insightCustomReports)
      .values({
        id,
        organizationId: context.organizationId,
        ownerUserId: context.userId,
        name: input.name,
        metricKeys: input.metricKeys,
        layout: input.layout,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      });
    return id;
  }

  /** One report by id, scoped to the acting user. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InsightCustomReportRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(insightCustomReports)
      .where(
        and(
          eq(insightCustomReports.organizationId, context.organizationId),
          eq(insightCustomReports.ownerUserId, context.userId),
          eq(insightCustomReports.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The acting user's reports in this studio, in id order (uuidv7 being time-ordered). */
  async listOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<InsightCustomReportRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(insightCustomReports)
      .where(
        and(
          eq(insightCustomReports.organizationId, context.organizationId),
          eq(insightCustomReports.ownerUserId, context.userId),
        ),
      )
      .orderBy(asc(insightCustomReports.id));
  }

  /**
   * Replace a report's editable fields by id, scoped to the acting user. Returns whether a row was
   * updated: an id that names another user's report (or no report) updates nothing and returns
   * `false`. Idempotent — replacing with the same values leaves the row's identity unchanged.
   */
  async replaceOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: InsightCustomReportInsert,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(insightCustomReports)
      .set({
        name: input.name,
        metricKeys: input.metricKeys,
        layout: input.layout,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(insightCustomReports.organizationId, context.organizationId),
          eq(insightCustomReports.ownerUserId, context.userId),
          eq(insightCustomReports.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /**
   * Delete a report by id, scoped to the acting user. Returns whether a row was removed: an id that
   * names another user's report (or no report) removes nothing and returns `false`.
   */
  async deleteOwn(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(insightCustomReports)
      .where(
        and(
          eq(insightCustomReports.organizationId, context.organizationId),
          eq(insightCustomReports.ownerUserId, context.userId),
          eq(insightCustomReports.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
