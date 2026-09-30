import { and, asc, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { billingCostCenters, projectBudgets } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Billing & entitlements (module 19, x331). The read-only data-access layer behind the cost-center
 * spend report — a roll-up of project budgets (`project_budgets`, 0160/x293) grouped by the cost
 * centres a billing admin defined (`billing_cost_centers`, 0150/x281). It owns no table and writes
 * nothing; it only reads, tenant-scoped, the two existing tables.
 *
 * It follows the `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 posture of its billing siblings:
 * every method takes the `TenantQueryRunner` and the `TenantContext` (no unscoped overload), the tenant
 * comes from the context and never a DTO, and every statement carries the `organization_id` predicate
 * so a forgotten one throws at the guard rather than leaking rows. The service groups and sums the rows
 * this layer returns; the join across the two tables is done in memory there, bounded by the tenant's
 * cost-centre and assignment counts.
 */

/** A cost-centre definition row: its id, code and display name, within the acting tenant. */
export interface CostCenterDefRow {
  readonly id: string;
  readonly code: string;
  readonly name: string | null;
}

/** A project→cost-centre assignment row: the shared `code` and the assigned project id. */
export interface CostCenterAssignmentRow {
  readonly code: string;
  readonly projectId: string;
}

/** A project's budget figures, read-only, for the roll-up. */
export interface ProjectBudgetFigureRow {
  readonly projectId: string;
  readonly budgetMinutes: number | null;
  readonly budgetAmountMinor: number | null;
  readonly currency: string | null;
}

export class CostCenterReportRepository {
  /** All cost-centre definition rows for the acting tenant, code-ascending. */
  async listDefs(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly CostCenterDefRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select({
        id: billingCostCenters.id,
        code: billingCostCenters.code,
        name: billingCostCenters.name,
      })
      .from(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'def'),
        ),
      )
      .orderBy(asc(billingCostCenters.code));
  }

  /** Every project→cost-centre assignment for the acting tenant (code, project id). */
  async listAssignments(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly CostCenterAssignmentRow[]> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        code: billingCostCenters.code,
        projectId: billingCostCenters.projectId,
      })
      .from(billingCostCenters)
      .where(
        and(
          eq(billingCostCenters.organizationId, context.organizationId),
          eq(billingCostCenters.rowKind, 'assignment'),
        ),
      )
      .orderBy(asc(billingCostCenters.code), asc(billingCostCenters.projectId));
    // An assignment row always carries a project id (a NULL project_id is a `def` row); the guard
    // never returns one here, so the narrowing is a type formality, not a runtime filter.
    return rows.flatMap((row) =>
      row.projectId === null ? [] : [{ code: row.code, projectId: row.projectId }],
    );
  }

  /**
   * The budget figures for the given project ids, within the acting tenant. Read only; no schema edit
   * to `project_budgets`. Returns nothing when `projectIds` is empty, so a tenant with no assignments
   * makes no second query.
   */
  async listBudgetsForProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectIds: readonly string[],
  ): Promise<readonly ProjectBudgetFigureRow[]> {
    if (projectIds.length === 0) return [];
    const db = tenantDrizzle(runner);
    return db
      .select({
        projectId: projectBudgets.projectId,
        budgetMinutes: projectBudgets.budgetMinutes,
        budgetAmountMinor: projectBudgets.budgetAmountMinor,
        currency: projectBudgets.currency,
      })
      .from(projectBudgets)
      .where(
        and(
          eq(projectBudgets.organizationId, context.organizationId),
          inArray(projectBudgets.projectId, [...projectIds]),
        ),
      );
  }
}
