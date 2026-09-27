import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { insightReportSchedules } from '../../common/database/schema.js';
import type {
  InsightReportCadence,
  InsightReportKind,
  InsightReportScheduleRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The fields a create carries. `ownerUserId` is the service's (`context.userId`), never the body's,
 * and `nextRunAt` is the application-computed next-due instant — not a server-clock default.
 */
export interface InsightReportScheduleInsert {
  readonly reportKey: InsightReportKind;
  readonly cadence: InsightReportCadence;
  readonly hour: number;
  readonly dayOfWeek: number | null;
  readonly nextRunAt: Date;
}

/**
 * INS report schedules (x228) — the create/list/delete store for a member's own recurring insights-
 * report definitions.
 *
 * Every method is scoped by `(organization_id, owner_user_id)`: a schedule is private to its creator,
 * so there is no method that returns another user's schedules and no method without an owner in its
 * predicate — the same shape `saved-views.repository.ts` (0089) takes. The queries run under the
 * tenant runner, so the layer-3 guard sees the `organization_id` predicate on every statement.
 */
export class InsightReportSchedulesRepository {
  /** Insert a schedule owned by `context.userId` and return its id. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsightReportScheduleInsert,
  ): Promise<string> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(insightReportSchedules)
      .values({
        id,
        organizationId: context.organizationId,
        ownerUserId: context.userId,
        reportKey: input.reportKey,
        cadence: input.cadence,
        hour: input.hour,
        dayOfWeek: input.dayOfWeek,
        nextRunAt: input.nextRunAt,
        createdAt: sql`current_timestamp(3)`,
      });
    return id;
  }

  /** One schedule by id, scoped to the acting user — the read-back after a create. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InsightReportScheduleRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(insightReportSchedules)
      .where(
        and(
          eq(insightReportSchedules.organizationId, context.organizationId),
          eq(insightReportSchedules.ownerUserId, context.userId),
          eq(insightReportSchedules.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** The acting user's schedules in this studio, in id order (uuidv7 being time-ordered). */
  async listOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<InsightReportScheduleRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(insightReportSchedules)
      .where(
        and(
          eq(insightReportSchedules.organizationId, context.organizationId),
          eq(insightReportSchedules.ownerUserId, context.userId),
        ),
      )
      .orderBy(asc(insightReportSchedules.id));
  }

  /**
   * Delete a schedule by id, scoped to the acting user. Returns whether a row was removed: an id that
   * names another user's schedule (or no schedule) removes nothing and returns `false`.
   */
  async deleteOwn(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(insightReportSchedules)
      .where(
        and(
          eq(insightReportSchedules.organizationId, context.organizationId),
          eq(insightReportSchedules.ownerUserId, context.userId),
          eq(insightReportSchedules.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
