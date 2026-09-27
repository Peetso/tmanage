import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemEstimateRepository } from './item-estimate.repository.js';

/**
 * x258's application service — an effort estimate per work item (Work module).
 *
 * The time-log service's shape without the list: the repository stays free of policy, the controller
 * stays free of both, and the rules that matter live here.
 *
 * ## Resolve the parent, tenant-scoped, BEFORE authorizing or writing
 *
 * Both routes name a `workItemId` in the path. The parent work item is read first, scoped to the
 * acting tenant — a `work_item_id` from another studio simply does not resolve, and the answer is the
 * same 404 an absent id gives. Only once the row is in hand is `authorize()` asked whether this
 * principal may act on it. A cross-tenant (or unrelated) parent is a 404 with no write, never an
 * estimate stored against somebody else's work.
 *
 * ## `authorize()` gates read and write
 *
 * The read gate is `work.read` on the parent item; the write gate is `work.update`. The estimate has
 * no audience of its own — it inherits the parent work item's.
 *
 * ## Estimate vs actual
 *
 * The read returns the stored estimate, the logged actual (summed from x231's time logs, read-only)
 * and the variance between them. A work item with no estimate reads `estimate: null`; one with no
 * logged time reads `actual: 0`.
 */

/** The client-facing projection of a work item's estimate vs actual. Paired in `e2e/contracts`. */
export interface WorkItemEstimateView {
  readonly workItemId: string;
  /** The planned effort in minutes, or `null` when none has been set. */
  readonly estimateMinutes: number | null;
  /** The logged actual effort in minutes, summed from the time logs; `0` when none logged. */
  readonly actualMinutes: number;
  /** `estimate - actual`, or `null` when there is no estimate to compare against. */
  readonly varianceMinutes: number | null;
  readonly updatedAt: string | null;
}

/** One day short of a working year in minutes — the ceiling a fat-finger cannot exceed. */
export const MAX_ESTIMATE_MINUTES = 100_000;

export class WorkItemEstimateService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly estimates: WorkItemEstimateRepository = new WorkItemEstimateRepository(),
  ) {}

  /** The work item's estimate vs actual. Behind `work.read` on the parent item. */
  async get(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemEstimateView> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const estimate = await this.estimates.find(runner, context, workItemId);
      const actualMinutes = await this.estimates.sumLoggedMinutes(runner, context, workItemId);
      return toView(
        workItemId,
        estimate?.estimateMinutes ?? null,
        actualMinutes,
        estimate?.updatedAt ?? null,
      );
    });
  }

  /** Set or revise the work item's estimate. Behind `work.update` on the parent item. */
  async set(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    estimateMinutes: number,
  ): Promise<WorkItemEstimateView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const saved = await this.estimates.upsert(tx, context, { workItemId, estimateMinutes });
      const actualMinutes = await this.estimates.sumLoggedMinutes(tx, context, workItemId);
      return toView(workItemId, saved.estimateMinutes, actualMinutes, saved.updatedAt);
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 the work-item read
   * produces for a row that does not exist.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'work.read', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toView(
  workItemId: string,
  estimateMinutes: number | null,
  actualMinutes: number,
  updatedAt: Date | null,
): WorkItemEstimateView {
  return {
    workItemId,
    estimateMinutes,
    actualMinutes,
    varianceMinutes: estimateMinutes === null ? null : estimateMinutes - actualMinutes,
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}
