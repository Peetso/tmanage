import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  projectBudgetPhases,
  projectBudgets,
  projectPhases,
  workItems,
  workItemTimeLogs,
} from '../../common/database/schema.js';
import type { ProjectBudgetPhaseRow, ProjectBudgetRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The project-budget repository — PROJ / project detail (x293), following the single-row-per-parent
 * upsert shape of `home-widget-prefs` (0115) and the tenant-scoped conventions of its projects-module
 * siblings.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally: every method's first
 * two parameters are the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the
 * tenant comes from the context and never a DTO, and every statement carries the `organization_id`
 * predicate.
 */

/** The substance a save persists. `organizationId`/`projectId`/`createdBy` are context, not this DTO. */
export interface SaveProjectBudgetInput {
  readonly projectId: string;
  /** Planned effort in minutes, or null when the budget names only an amount. */
  readonly budgetMinutes: number | null;
  /** Planned amount in the minor unit of `currency`, or null when the budget names only effort. */
  readonly budgetAmountMinor: number | null;
  /** ISO-4217 alphabetic code, or null when no amount is budgeted. */
  readonly currency: string | null;
  /** The person setting the budget — the service passes `context.userId` (insert path only). */
  readonly createdBy: string;
  /** 52-05 (0291). */
  readonly budgetType: string;
  readonly includeExpenses: boolean;
  readonly clientVisible: boolean;
  /** Comma-separated whole percents, already validated. */
  readonly alertThresholds: string;
}

/** 52-05 (0291). One phase line of a budget's split. */
export interface BudgetPhaseInput {
  readonly phaseId: string | null;
  readonly name: string;
  readonly budgetMinutes: number | null;
  readonly budgetAmountMinor: number | null;
  readonly position: number;
}

export class ProjectBudgetRepository {
  /**
   * Fetch one project's budget row, within the acting tenant. No `findById(id)` without a context: on
   * MySQL that would return another customer's row.
   */
  async findForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ProjectBudgetRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectBudgets)
      .where(
        and(
          eq(projectBudgets.organizationId, context.organizationId),
          eq(projectBudgets.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create or replace this project's budget, within the acting tenant. One upsert against
   * `uq_project_budgets_org_project`, so two saves racing for one project's row serialise on the
   * unique key rather than on a row this code read first — a lost update is not expressible. The
   * insert path fills `id` and `created_by`; the update path leaves both alone (the 0160 trigger pins
   * them at the engine) and moves only the substance columns; `updated_at` follows the column's
   * `ON UPDATE`.
   *
   * The project is not checked to belong to the tenant here: the composite foreign key
   * `fk_project_budgets_project_tenant` includes `organization_id`, so the database refuses a project
   * from another tenant. (The service resolves the project first, to map an unknown id to 404 rather
   * than a foreign-key 500.)
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SaveProjectBudgetInput,
  ): Promise<ProjectBudgetRow> {
    const db = tenantDrizzle(runner);
    await db
      .insert(projectBudgets)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        projectId: input.projectId,
        budgetMinutes: input.budgetMinutes,
        budgetAmountMinor: input.budgetAmountMinor,
        currency: input.currency,
        createdBy: input.createdBy,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
        budgetType: input.budgetType,
        includeExpenses: input.includeExpenses,
        clientVisible: input.clientVisible,
        alertThresholds: input.alertThresholds,
      })
      .onDuplicateKeyUpdate({
        set: {
          budgetMinutes: input.budgetMinutes,
          budgetAmountMinor: input.budgetAmountMinor,
          currency: input.currency,
          budgetType: input.budgetType,
          includeExpenses: input.includeExpenses,
          clientVisible: input.clientVisible,
          alertThresholds: input.alertThresholds,
        },
      });

    const saved = await this.findForProject(runner, context, input.projectId);
    if (!saved) {
      // The upsert just wrote this row within the same tenant; a missing read-back is a real fault.
      throw new Error(`project_budgets row for project ${input.projectId} vanished after upsert`);
    }
    return saved;
  }

  /**
   * Sum the effort already tracked on the project's work items, in minutes, within the acting tenant.
   *
   * Reads `work_item_time_logs` (0103) joined to `work_items` on the composite `(organization_id, id)`
   * key, filtered to the project. Read-only: this slice never writes a time log. `COALESCE(SUM, 0)`
   * so a project with no logged effort sums to `0` rather than `NULL`. mysql2 returns a `DECIMAL` sum
   * as a string, so the caller coerces with `Number(...)`.
   */
  async sumTrackedMinutes(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${workItemTimeLogs.minutes}), 0)` })
      .from(workItemTimeLogs)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, workItemTimeLogs.organizationId),
          eq(workItems.id, workItemTimeLogs.workItemId),
        ),
      )
      .where(
        and(
          eq(workItemTimeLogs.organizationId, context.organizationId),
          // 0410 time trust: only the minutes that count.
          eq(workItemTimeLogs.counted, true),
          eq(workItems.projectId, projectId),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  /** 52-05. The budget's phase split, in position order. */
  async listPhases(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly ProjectBudgetPhaseRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(projectBudgetPhases)
      .where(
        and(
          eq(projectBudgetPhases.organizationId, context.organizationId),
          eq(projectBudgetPhases.projectId, projectId),
        ),
      )
      .orderBy(asc(projectBudgetPhases.position), asc(projectBudgetPhases.id));
  }

  /**
   * 52-05. How many of these ids are phase definition rows of this project in this tenant — the
   * service refuses a split naming any other id (a 400, never a dangling reference).
   */
  async countProjectPhases(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    phaseIds: readonly string[],
  ): Promise<number> {
    if (phaseIds.length === 0) return 0;
    const rows = await tenantDrizzle(runner)
      .select({ id: projectPhases.id })
      .from(projectPhases)
      .where(
        and(
          eq(projectPhases.organizationId, context.organizationId),
          eq(projectPhases.projectId, projectId),
          isNull(projectPhases.milestoneId),
          inArray(projectPhases.id, [...phaseIds]),
        ),
      );
    return rows.length;
  }

  /** 52-05. Replace the whole split (delete, then insert), inside the caller's transaction. */
  async replacePhases(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    phases: readonly BudgetPhaseInput[],
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(projectBudgetPhases)
      .where(
        and(
          eq(projectBudgetPhases.organizationId, context.organizationId),
          eq(projectBudgetPhases.projectId, projectId),
        ),
      );
    if (phases.length === 0) return;
    await db.insert(projectBudgetPhases).values(
      phases.map((phase) => ({
        id: uuidv7(),
        organizationId: context.organizationId,
        projectId,
        phaseId: phase.phaseId,
        name: phase.name,
        budgetMinutes: phase.budgetMinutes,
        budgetAmountMinor: phase.budgetAmountMinor,
        position: phase.position,
        createdAt: sql`current_timestamp(3)`,
      })),
    );
  }
}
