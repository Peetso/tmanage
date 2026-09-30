import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  CostCenterReportRepository,
  type CostCenterAssignmentRow,
  type CostCenterDefRow,
  type ProjectBudgetFigureRow,
} from './cost-center-report.repository.js';

/**
 * Billing & entitlements (module 19, x331). The read-only spend-by-cost-centre report — for each cost
 * centre a billing admin defined (`billing_cost_centers`, x281), the count of projects assigned to it
 * and the summed budget (effort and amount) of those projects (`project_budgets`, x293). It stores
 * nothing and writes nothing; it reads the two existing tables, tenant-scoped, and rolls them up.
 *
 * ## The capability
 *
 * Billing is an org-admin concern, so the report reuses `org.manage` — the same divergence
 * `cost-centers.service.ts` records, and no billing capability exists. The route guard asks the coarse
 * ceiling question; this service adds the authoritative, deny-by-default application decision
 * (`25-AUTH` §3 step 2): an org-scoped `authorize()` a suspended membership fails, made **before** any
 * read, so a caller without `org.manage` gets a 403 and no row is ever read.
 *
 * ## Tenant scope
 *
 * The tenant comes from the context the guard resolved, never a body. Both source reads carry the
 * `organization_id` predicate (the repository), so another tenant's cost centres, assignments and
 * budgets can never enter the roll-up; a cross-tenant project id simply has no budget row for this
 * tenant. An unknown or empty tenant reads back nothing and answers `200` with an empty list — an
 * aggregate read that leaks no existence, matching the x86/x109 precedent.
 *
 * ## The sum, and mixed currencies
 *
 * Effort sums in minutes (the unit `project_budgets` stores) and is converted to hours at the wire
 * edge, the way `budget.service.ts` speaks `budgetHours`. Amounts sum in their minor unit. Because a
 * cost centre may gather projects budgeted in different currencies, `currency` is the single code when
 * every budgeted amount under the cost centre shares one, and `null` when there is none or more than
 * one — so a consumer never reads a mixed-currency total as a single figure.
 */

/**
 * One cost centre's roll-up on the wire: its id, code, display name, the number of projects assigned
 * to it, and the summed budget of those projects. `organizationId` is deliberately absent — the
 * projection never echoes the tenant id.
 */
export interface CostCenterReportRowView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** How many projects are assigned to this cost centre (whether or not they carry a budget). */
  readonly projectCount: number;
  /** Summed budgeted effort of the assigned projects, in hours; `0` when none is budgeted. */
  readonly totalBudgetHours: number;
  /** Summed budgeted amount of the assigned projects, in the minor unit; `0` when none is budgeted. */
  readonly totalBudgetAmountMinor: number;
  /** The single currency of the summed amount, or `null` when there is none or amounts are mixed. */
  readonly currency: string | null;
}

export class CostCenterReportService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly reports: CostCenterReportRepository = new CostCenterReportRepository(),
  ) {}

  /**
   * The spend-by-cost-centre report for the acting tenant, code-ascending. `org.manage` org-scoped: a
   * caller without it is a 403 decided before any read. Cost centres with no assignments report a zero
   * count and zero totals.
   */
  async report(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly CostCenterReportRowView[]> {
    this.requireOrgManage(principal, context, 'cost_center_report.read');

    const { defs, assignments, budgets } = await this.database.read(context, async (runner) => {
      const defRows = await this.reports.listDefs(runner, context);
      const assignmentRows = await this.reports.listAssignments(runner, context);
      const projectIds = [...new Set(assignmentRows.map((row) => row.projectId))];
      const budgetRows = await this.reports.listBudgetsForProjects(runner, context, projectIds);
      return { defs: defRows, assignments: assignmentRows, budgets: budgetRows };
    });

    return rollUp(defs, assignments, budgets);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private requireOrgManage(principal: Principal, context: TenantContext, action: string): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

/**
 * Group the assignments by cost-centre code and fold each assigned project's budget into the cost
 * centre's totals. Only assignments whose code names a definition are counted (a stray assignment with
 * no def is ignored); a project assigned to a cost centre but with no budget row contributes to the
 * project count and nothing to the sums.
 */
function rollUp(
  defs: readonly CostCenterDefRow[],
  assignments: readonly CostCenterAssignmentRow[],
  budgets: readonly ProjectBudgetFigureRow[],
): readonly CostCenterReportRowView[] {
  const budgetByProject = new Map<string, ProjectBudgetFigureRow>();
  for (const budget of budgets) budgetByProject.set(budget.projectId, budget);

  const projectsByCode = new Map<string, string[]>();
  for (const assignment of assignments) {
    const list = projectsByCode.get(assignment.code) ?? [];
    list.push(assignment.projectId);
    projectsByCode.set(assignment.code, list);
  }

  return defs.map((def) => {
    const projectIds = projectsByCode.get(def.code) ?? [];
    let totalMinutes = 0;
    let totalAmountMinor = 0;
    const currencies = new Set<string>();

    for (const projectId of projectIds) {
      const budget = budgetByProject.get(projectId);
      if (!budget) continue;
      if (budget.budgetMinutes !== null) totalMinutes += budget.budgetMinutes;
      if (budget.budgetAmountMinor !== null) {
        totalAmountMinor += budget.budgetAmountMinor;
        if (budget.currency !== null) currencies.add(budget.currency);
      }
    }

    return {
      id: def.id,
      code: def.code,
      name: def.name ?? '',
      projectCount: projectIds.length,
      totalBudgetHours: totalMinutes / 60,
      totalBudgetAmountMinor: totalAmountMinor,
      currency: currencies.size === 1 ? [...currencies][0]! : null,
    };
  });
}
