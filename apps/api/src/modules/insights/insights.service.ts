import { authorize } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import {
  ProjectsRepository,
  effectivePageSize as projectPageSize,
} from '../projects/projects.repository.js';
import type { DeliveryFlowRepository } from './delivery-flow.repository.js';
import type { ApprovalCycleMetrics, ApprovalCycleRepository } from './approval-cycle.repository.js';

/**
 * INS-01's first vertical slice — the insights module's read half.
 *
 * The module is read-only by nature (a reporting surface, not a `work.create`-style write), so
 * there is no mutation in this slice. The one read computes a project's delivery flow — work-item
 * counts by workflow status — over the existing `work` data via {@link DeliveryFlowRepository},
 * which reuses `WorkItemsRepository` read-only.
 *
 * ## Capability
 *
 * The read is exposed behind `work.read` (on the controller), the same internal-read capability
 * x86's project-health roll-up uses. That is a deliberate reuse: it avoids editing the capability
 * table or x82's role/operation grid, so this slice stays parallel-safe and needs no migration. A
 * dedicated `insights.read` is the clean follow-up once the module grows — and would then require
 * the capability-table + grid edits x90/x91 make. The service applies the *relation* half of the
 * same capability per row through {@link mayRead}, exactly as `WorkItemsService` does, so a caller
 * with the role but no relation to the project's items contributes nothing.
 */

/**
 * The audiences a client principal may read — `12-PERMISSION-MATRIX` §2. `internal` is absent,
 * and that absence is the control: an internal item is not a narrower view a client sees, it is a
 * row they must not know exists. Mirrors `WorkItemsService`'s own constant.
 */
const CLIENT_AUDIENCES: readonly Audience[] = ['client_visible', 'client_action_required'];

/**
 * INS-01's read shape — a project's delivery flow.
 *
 * `counts` tallies the project's readable work items by workflow status (`backlog … archived`);
 * `itemCount` is their sum, which lets a consumer tell an empty project (every count 0) apart from
 * one it simply may not read into. Computed, never stored: no column, no write, no schedule.
 */
export interface DeliveryFlowView {
  readonly projectId: string;
  readonly counts: Record<WorkItemState, number>;
  readonly itemCount: number;
  readonly computedAt: string;
}

/**
 * INS-02's read shape — a project's approval cycle.
 *
 * `metrics` rolls the project's readable approvals up by terminal outcome (`approved`,
 * `changes_requested`, `invalidated`): per outcome, the count, the number of those that carry a
 * decision time, and the summed requested→decided duration of exactly those. `approvalCount` is
 * their total, which lets a consumer tell an empty project (every count 0) apart from one it
 * simply may not read into. Computed, never stored: no column, no write, no schedule.
 */
export interface ApprovalCycleView {
  readonly projectId: string;
  readonly metrics: ApprovalCycleMetrics;
  readonly approvalCount: number;
  readonly computedAt: string;
}

/**
 * INS-01's portfolio roll-up — one accessible project's headline insight figures.
 *
 * The two figures are the *same* per-project reads the per-project screens show, not a second
 * computation: `deliveryFlow` is {@link InsightsService.projectDeliveryFlow}'s output and
 * `approvalCycle` is {@link InsightsService.projectApprovalCycle}'s, composed here so the portfolio
 * index and the per-project dashboard can never disagree about a project's numbers. `name` is the
 * project's own display name, the only project column the index needs to link a drill-in row. No
 * raw work-item or approval row ever appears — only the bounded, computed roll-ups.
 */
export interface InsightsPortfolioProject {
  readonly projectId: string;
  readonly name: string;
  readonly deliveryFlow: DeliveryFlowView;
  readonly approvalCycle: ApprovalCycleView;
}

/**
 * INS-01's portfolio read shape — the org-level roll-up across the caller's accessible projects.
 *
 * `projects` is a bounded, id-ordered page of the projects this caller may read (a project they
 * cannot read never appears, and cross-tenant never resolves — the same access filter the projects
 * list and the per-project reads apply). `projectCount` is the number of rows in this page — the
 * count the caller can see, never the tenant's total. Computed on demand, never stored.
 */
export interface InsightsPortfolioView {
  readonly projects: readonly InsightsPortfolioProject[];
  readonly projectCount: number;
  readonly computedAt: string;
}

/**
 * The portfolio page bounds — x93/x98/x115 precedent (default 20, hard max 50). Small because each
 * project row is two per-project roll-ups, so the page size caps composed reads per request.
 */
export const PORTFOLIO_DEFAULT_PAGE_SIZE = 20;
export const PORTFOLIO_MAX_PAGE_SIZE = 50;

/** The number of readable projects one portfolio page resolves to, clamped to the bounds above. */
export function portfolioPageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? PORTFOLIO_DEFAULT_PAGE_SIZE, 1), PORTFOLIO_MAX_PAGE_SIZE);
}

/**
 * How many repository pages the portfolio walk may read while filling a page of *readable*
 * projects. `mayReadProject` is `authorize()`'s relation rule, not a column, so it runs per row
 * after the query and can shorten a page — the same walk `PortalService.projectsFor` uses. At the
 * project read's page size this budget examines a bounded number of rows and then stops rather than
 * scanning an unbounded tenant.
 */
const PORTFOLIO_PAGE_BUDGET = 25;

export interface PortfolioOptions {
  /** Keyset cursor into the projects list: start after this project id. */
  readonly after?: string;
  /** Requested page size, clamped by {@link portfolioPageSize}. */
  readonly limit?: number;
}

export class InsightsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly deliveryFlow: DeliveryFlowRepository,
    private readonly approvalCycle: ApprovalCycleRepository,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * The portfolio roll-up: INS-01's headline figures for each project the caller may read.
   *
   * ## Off-project / cross-tenant discipline (Known trap — route added)
   *
   * The route takes no project id, so the trap surfaces as *inclusion*: a project the caller
   * cannot read, or one in another tenant, must be silently excluded — never 500, never leaked.
   * That is exactly what happens. The projects list is tenant-scoped in SQL (a cross-tenant row is
   * never returned), and {@link mayReadProject} re-checks the caller's `work.read` relation on each
   * returned row before it is included — the *same* access filter `ProjectsService.list` and the
   * per-project reads apply, not a new visibility rule. An inaccessible project simply contributes
   * no row.
   *
   * ## Figures are the per-project reads, not a second computation
   *
   * Each row's `deliveryFlow`/`approvalCycle` come from {@link projectDeliveryFlow} /
   * {@link projectApprovalCycle}, so the portfolio index and the per-project dashboard read the
   * same numbers by construction. The approval figures still respect `approval.read` per row (the
   * per-project read's own relation check), so a caller with `work.read` but not `approval.read`
   * sees a project's delivery flow with an empty approval cycle rather than another caller's
   * approvals — no capability is escalated by composing the reads behind this route's `work.read`.
   */
  async portfolio(
    context: TenantContext,
    principal: Principal,
    options: PortfolioOptions = {},
  ): Promise<InsightsPortfolioView> {
    const now = new Date();
    const limit = portfolioPageSize(options.limit);
    const pageSize = projectPageSize(undefined);

    const accessible = await this.database.read(context, async (runner) => {
      const collected: ProjectRow[] = [];
      let after = options.after;
      for (let pages = 0; pages < PORTFOLIO_PAGE_BUDGET; pages += 1) {
        const page = await this.projects.list(runner, context, {
          ...(after === undefined ? {} : { after }),
          limit: pageSize,
        });
        for (const row of page) {
          if (this.mayReadProject(principal, row)) collected.push(row);
        }
        const last = page[page.length - 1];
        if (page.length < pageSize || collected.length >= limit || last === undefined) break;
        after = last.id;
      }
      return collected.slice(0, limit);
    });

    const projects: InsightsPortfolioProject[] = [];
    for (const project of accessible) {
      const [deliveryFlow, approvalCycle] = await Promise.all([
        this.projectDeliveryFlow(context, principal, project.id),
        this.projectApprovalCycle(context, principal, project.id),
      ]);
      projects.push({ projectId: project.id, name: project.name, deliveryFlow, approvalCycle });
    }

    return { projects, projectCount: projects.length, computedAt: now.toISOString() };
  }

  /**
   * A project's delivery flow: counts of work items by workflow status.
   *
   * A pure read over the `work` data. A client principal is narrowed to the client audiences
   * before the query runs, and every row is re-checked by {@link mayRead} — the belt-and-braces
   * `WorkItemsService` applies — so a cross-tenant row (never returned by the tenant-scoped SQL
   * in the first place) or an item the caller has no relation to never contributes.
   */
  async projectDeliveryFlow(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<DeliveryFlowView> {
    const now = new Date();
    const audiences = principal.kind === 'client' ? CLIENT_AUDIENCES : undefined;

    const rollup = await this.database.read(context, (runner) =>
      this.deliveryFlow.deliveryFlow(runner, context, projectId, {
        ...(audiences ? { audiences } : {}),
        keep: (row) => this.mayRead(principal, row),
      }),
    );

    return {
      projectId,
      counts: rollup.counts,
      itemCount: rollup.itemCount,
      computedAt: now.toISOString(),
    };
  }

  /**
   * A project's approval cycle: counts of approvals by terminal outcome, with the decided ones'
   * requested→decided durations.
   *
   * INS-01's delivery-flow read, over the `approvals` data instead of `work`. It reuses
   * `approval.read` (on the controller), the capability x92's approvals module already defines and
   * grants — a deliberate reuse that avoids editing the capability table or x82's role/operation
   * grid, so this slice stays parallel-safe and needs no migration. Every row is re-checked by
   * {@link mayReadApproval} — the belt-and-braces `WorkItemsService` applies — so a cross-tenant
   * row (never returned by the tenant-scoped SQL in the first place) or an approval the caller has
   * no relation to never contributes.
   */
  async projectApprovalCycle(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ApprovalCycleView> {
    const now = new Date();

    const rollup = await this.database.read(context, (runner) =>
      this.approvalCycle.approvalCycle(runner, context, projectId, {
        keep: (row) => this.mayReadApproval(principal, row),
      }),
    );

    return {
      projectId,
      metrics: rollup.metrics,
      approvalCount: rollup.approvalCount,
      computedAt: now.toISOString(),
    };
  }

  /**
   * Whether this principal may read an approval, judged by `approval.read` against the approval's
   * own project — the same capability, and the same resource shape, x92's `ApprovalsService`
   * applies to a decision. Approvals carry no audience column and are inherently client-visible
   * governed content, so the resource is fixed at `client_visible`/`active`, exactly as the
   * approvals module's own authorize does. This is the relation half of the capability the
   * controller already gated on the role.
   */
  private mayReadApproval(principal: Principal, row: ApprovalRow): boolean {
    return authorize({
      principal,
      capability: 'approval.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: 'client_visible',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * Whether this principal may read a project, judged by `work.read` against the project's own
   * relation and lifecycle — the *same* rule and resource shape `ProjectsService.list` applies to
   * decide which projects a caller sees. Audience is `internal` because a project row is an
   * internal object (the client-facing view is the portal's, not this). Reusing this exact shape,
   * rather than inventing a portfolio-specific visibility rule, is what keeps an off-project /
   * cross-tenant project out of the roll-up.
   */
  private mayReadProject(principal: Principal, row: ProjectRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.id,
        audience: 'internal',
        lifecycle: row.archivedAt ? 'archived' : 'active',
      },
    }).allowed;
  }

  /**
   * Whether this principal may read a work item, judged by `work.read` against the item's own
   * project and audience — the same rule, and the same resource shape, `WorkItemsService.mayRead`
   * applies. This is the relation half of the capability the controller already gated on the role.
   */
  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: row.audience,
        lifecycle: row.deletedAt
          ? 'soft_deleted'
          : row.state === 'archived'
            ? 'archived'
            : 'active',
      },
    }).allowed;
  }
}
