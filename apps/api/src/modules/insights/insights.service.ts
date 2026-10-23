import { authorize } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';
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
 * INS-05's "open" states — every work-item state except the two that are not open work: `done` and
 * the terminal `archived` (`23-ERD-AND-STATE-MACHINES` §5). Identical to `WorkViewsService`'s own
 * list (WK-06): a workload roll-up answers "what is still on people's plates across the portfolio",
 * so completed and archived work must not inflate any project's capacity count.
 */
const OPEN_WORK_STATES: readonly WorkItemState[] = [
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'internal_review',
];

/**
 * INS-05 bounds the org-wide roll-up the way x93/x115/x120 bound their portfolio reads: a caller
 * may ask for fewer, never for more than a page. Default 20, hard ceiling 50 projects — enough for
 * a studio's live portfolio without turning one request into an unbounded fan-out of per-project
 * work reads.
 */
const DEFAULT_WORKLOAD_PROJECT_LIMIT = 20;
const MAX_WORKLOAD_PROJECT_LIMIT = 50;

/** The requested project bound, clamped to `[1, 50]`; a missing or non-finite value is the default 20. */
function clampWorkloadProjectLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_WORKLOAD_PROJECT_LIMIT;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_WORKLOAD_PROJECT_LIMIT);
}

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
  /**
   * A13 "Projects in this report": keep only these project ids. Ids the caller cannot read (or
   * that do not exist in this tenant) are dropped silently — the filter never widens access.
   * Absent or empty means every readable project.
   */
  readonly projectIds?: readonly string[];
}

/**
 * INS-05's per-project row — one project's slice of the org-wide workload roll-up.
 *
 * `openItemCount` is the project's open work the caller may read; `scheduledItemCount` is the part
 * of it on the calendar (a `startAt` or a `dueAt`) — the same derived load `WorkViewsService`'s
 * per-project workload computes. `assigneeCount` is the distinct owners carrying that open work
 * (the project's *capacity in use*); the unassigned pile is not a person and does not count toward
 * it. `organizationId` is absent: the caller already knows which organization they asked about.
 */
export interface InsightsWorkloadProject {
  readonly projectId: string;
  readonly openItemCount: number;
  readonly scheduledItemCount: number;
  readonly assigneeCount: number;
}

/**
 * INS-05's aggregate — the roll-up totalled across the projects that entered it. `projectCount` is
 * how many projects contributed (those the caller may read, up to the bound), `assigneeCount` is
 * the distinct people carrying open work anywhere in that set (counted once even when they carry
 * work in several projects), and the two item counts sum the per-project figures.
 */
export interface InsightsWorkloadTotals {
  readonly projectCount: number;
  readonly assigneeCount: number;
  readonly openItemCount: number;
  readonly scheduledItemCount: number;
}

/**
 * INS-05's read shape — the org-wide workload/capacity portfolio roll-up. `projects` is the
 * per-project breakdown (heaviest first), `totals` the aggregate across them. Computed, never
 * stored: no column, no write, no schedule. Paired in `e2e/contracts/api-web-shapes.ts` with the
 * web shape the Insights screen's workload section consumes (CONTRACT-001).
 */
export interface InsightsWorkloadView {
  readonly projects: readonly InsightsWorkloadProject[];
  readonly totals: InsightsWorkloadTotals;
  readonly computedAt: string;
}

/** Options for the org-wide workload roll-up — the project bound the controller passes through. */
export interface OrgWorkloadOptions {
  /** How many projects to roll up, clamped to `[1, 50]`; omitted is the default 20. */
  readonly limit?: number;
}

export class InsightsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly deliveryFlow: DeliveryFlowRepository,
    private readonly approvalCycle: ApprovalCycleRepository,
    /**
     * Reused as-is from x99 (WK-06) — the per-project open-work read the roll-up runs once per
     * project. It applies no policy; `mayRead` and the aggregation stay here, exactly as
     * `WorkViewsService` keeps them out of the repository.
     */
    private readonly workload: WorkloadRepository = new WorkloadRepository(),
    /**
     * Read-only, and used for one thing: enumerating the tenant's projects the roll-up walks. The
     * `list` is tenant-scoped in SQL, so a cross-tenant project never appears; the per-project
     * `authorize` below is the belt-and-braces relation half.
     */
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
    const only =
      options.projectIds && options.projectIds.length > 0 ? new Set(options.projectIds) : null;

    const accessible = await this.database.read(context, async (runner) => {
      const collected: ProjectRow[] = [];
      let after = options.after;
      for (let pages = 0; pages < PORTFOLIO_PAGE_BUDGET; pages += 1) {
        const page = await this.projects.list(runner, context, {
          ...(after === undefined ? {} : { after }),
          limit: pageSize,
        });
        for (const row of page) {
          if (only !== null && !only.has(row.id)) continue;
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
   * The org-wide workload roll-up: per-project and aggregate open-work/capacity counts across the
   * projects this principal may read, reusing x99's per-project workload read (WK-06).
   *
   * A pure read. The projects are enumerated tenant-scoped (`ProjectsRepository.list`, bounded to
   * `[1, 50]`, default 20), and **every project is resolved tenant-scoped before it enters the
   * aggregate** — the FAST-PROTOCOL Known-trap (resolve/scope before the relation check, as
   * `MeetingsService.create` does after `75e2913`). Concretely:
   *
   * - The enumeration is tenant-scoped, so a cross-tenant project is never listed; and belt-and-
   *   braces, each project is authorized against its **own** `organizationId` with `work.read`, so
   *   a cross-tenant row that somehow reached this loop is dropped by the tenant check rather than
   *   fanning out a read — excluded, never a 500.
   * - A non-org-wide principal passes the `work.read` relation check only for the projects they are
   *   on, so they see only those projects' workload — no cross-project leak. A principal off every
   *   project gets an empty roll-up (`projects: []`, zero totals), never a 403: the route's role
   *   ceiling is the 403, the relation half is a filter.
   *
   * Within each readable project, every work row is re-checked by {@link mayRead} (belt-and-braces
   * to the open-state-filtered, tenant-scoped SQL) and a client principal is narrowed to the client
   * audiences before the query. No write, no new column, no schedule.
   */
  async orgWorkload(
    context: TenantContext,
    principal: Principal,
    options: OrgWorkloadOptions = {},
  ): Promise<InsightsWorkloadView> {
    const now = new Date();
    const limit = clampWorkloadProjectLimit(options.limit);
    const audiences = principal.kind === 'client' ? CLIENT_AUDIENCES : undefined;

    const rolled = await this.database.read(context, async (runner) => {
      const projectRows = await this.projects.list(runner, context, { limit });

      const perProject: InsightsWorkloadProject[] = [];
      const orgAssignees = new Set<string>();
      let totalOpen = 0;
      let totalScheduled = 0;

      for (const project of projectRows) {
        // Resolve-before-relation-check (Known-trap): a cross-tenant row is refused by the tenant
        // check inside authorize (against the project's own org), so it never fans out a read; a
        // non-org-wide caller only passes for a project they are on.
        if (!this.mayReadProject(principal, project)) continue;

        const items = await this.workload.listOpenProjectItems(
          runner,
          context,
          project.id,
          OPEN_WORK_STATES,
          { ...(audiences ? { audiences } : {}) },
        );

        let openItemCount = 0;
        let scheduledItemCount = 0;
        const owners = new Set<string>();
        for (const row of items) {
          // Belt-and-braces to the tenant-scoped, open-state-filtered SQL.
          if (!this.mayRead(principal, row)) continue;
          openItemCount += 1;
          if (row.startAt !== null || row.dueAt !== null) scheduledItemCount += 1;
          if (row.ownerUserId !== null) {
            owners.add(row.ownerUserId);
            orgAssignees.add(row.ownerUserId);
          }
        }

        perProject.push({
          projectId: project.id,
          openItemCount,
          scheduledItemCount,
          assigneeCount: owners.size,
        });
        totalOpen += openItemCount;
        totalScheduled += scheduledItemCount;
      }

      return { perProject, orgAssigneeCount: orgAssignees.size, totalOpen, totalScheduled };
    });

    const projects = [...rolled.perProject].sort(compareForWorkloadProject);

    return {
      projects,
      totals: {
        projectCount: projects.length,
        assigneeCount: rolled.orgAssigneeCount,
        openItemCount: rolled.totalOpen,
        scheduledItemCount: rolled.totalScheduled,
      },
      computedAt: now.toISOString(),
    };
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

/**
 * The roll-up order: heaviest first — by open-item count, then by scheduled (calendar) load as the
 * tie-break, then by project id so the order is total and stable. Ids compare as strings, which is
 * their creation order. Mirrors `WorkViewsService`'s per-assignee `compareForWorkload`, one level
 * up at the project grain.
 */
function compareForWorkloadProject(
  left: InsightsWorkloadProject,
  right: InsightsWorkloadProject,
): number {
  if (left.openItemCount !== right.openItemCount) return right.openItemCount - left.openItemCount;
  if (left.scheduledItemCount !== right.scheduledItemCount) {
    return right.scheduledItemCount - left.scheduledItemCount;
  }
  return left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0;
}
