import { authorize } from '@tmanage/domain';
import type { Audience, Principal, WorkItemState } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, WorkItemRow } from '../../common/database/schema.js';
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

export class InsightsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly deliveryFlow: DeliveryFlowRepository,
    private readonly approvalCycle: ApprovalCycleRepository,
  ) {}

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
