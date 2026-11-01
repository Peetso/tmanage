import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { automationSchedules } from '../../common/database/schema.js';
import type { AutomationScheduleRow } from '../../common/database/schema.js';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ScheduleSpec } from './next-run.js';

/**
 * Automations scheduled triggers repository (x167), following the `decisions`/`work_forms` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, as the sibling
 * repositories honour it: every method's first two parameters are the {@link TenantQueryRunner} and
 * the {@link TenantContext}; the tenant comes from the context, never the input; the tenant predicate
 * is on every statement, executed through the guard. The runner is a parameter, not a field — the
 * repository holds no connection and no state.
 */

/**
 * The insert shape. Note what is absent: `organizationId` — it is taken from the context, so there is
 * no field a request body could populate.
 */
export interface CreateAutomationScheduleInput {
  readonly templateId: string;
  readonly spec: ScheduleSpec;
  readonly nextRunAt: Date;
  readonly enabled: boolean;
}

export class AutomationSchedulesRepository {
  /**
   * Whether the named workflow template exists **inside the acting tenant**.
   *
   * The schedule points at a `workflow_templates` row (x162, migration 0063). That table is created
   * by a sibling slice and is not part of this slice's typed schema, so the existence check is a raw,
   * parameterised statement rather than a Drizzle query — the tenant predicate (`organization_id`) is
   * present exactly as the guard requires. Resolving the template tenant-scoped here is what lets the
   * service map an unknown or cross-tenant `templateId` to a 404 rather than to a foreign-key 500.
   */
  async templateExists(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<boolean> {
    const rows = await runner.query<QueryRows>(
      `select id from workflow_templates where organization_id = ? and id = ? limit 1`,
      [context.organizationId, templateId],
    );
    return rows.length > 0;
  }

  /**
   * List the acting tenant's schedules, soonest-due first.
   *
   * The `organization_id` predicate is present; the order is `next_run_at ASC, id ASC` — the due
   * order the screen reads by, with `id` (UUIDv7) as the deterministic tiebreaker.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AutomationScheduleRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(automationSchedules)
      .where(eq(automationSchedules.organizationId, context.organizationId))
      .orderBy(asc(automationSchedules.nextRunAt), asc(automationSchedules.id));
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    scheduleId: string,
  ): Promise<AutomationScheduleRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(automationSchedules)
      .where(
        and(
          eq(automationSchedules.organizationId, context.organizationId),
          eq(automationSchedules.id, scheduleId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a schedule.
   *
   * The id is generated here (UUIDv7). `organization_id` comes from the context, never from `input`.
   * The template is not re-checked to belong to the tenant here: the composite foreign key
   * `fk_automation_schedules_template_tenant` includes `organization_id`, so the database refuses a
   * template from another tenant — the service resolves the template first only to map an unknown id
   * to a 404 rather than to a foreign-key 500.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateAutomationScheduleInput,
  ): Promise<AutomationScheduleRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(automationSchedules).values({
      id,
      organizationId: context.organizationId,
      templateId: input.templateId,
      specJson: input.spec,
      nextRunAt: input.nextRunAt,
      enabled: input.enabled,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // The row was just inserted inside this unit of work; a missing read-back is a bug, not a
      // not-found to be mapped.
      throw new Error(`automation_schedule ${id} was not found after insert`);
    }
    return created;
  }

  /**
   * 2026-10-31 live-test fix: turn one schedule on or off, within the acting tenant. Turning it on
   * also moves `next_run_at` forward (the caller computes it from now), so a schedule paused for a
   * while never comes back with a due time in the past. Returns false when no tenant-owned row has
   * that id.
   */
  async setEnabled(
    runner: TenantQueryRunner,
    context: TenantContext,
    scheduleId: string,
    enabled: boolean,
    nextRunAt: Date | null,
  ): Promise<boolean> {
    const existing = await this.findById(runner, context, scheduleId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .update(automationSchedules)
      .set(nextRunAt ? { enabled, nextRunAt } : { enabled })
      .where(
        and(
          eq(automationSchedules.organizationId, context.organizationId),
          eq(automationSchedules.id, scheduleId),
        ),
      );
    return true;
  }

  /**
   * 2026-10-31 live-test fix: remove one schedule, within the acting tenant. The runs it already made
   * live in `workflow_runs` and stay. Returns false when no tenant-owned row has that id.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    scheduleId: string,
  ): Promise<boolean> {
    const existing = await this.findById(runner, context, scheduleId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(automationSchedules)
      .where(
        and(
          eq(automationSchedules.organizationId, context.organizationId),
          eq(automationSchedules.id, scheduleId),
        ),
      );
    return true;
  }
}
