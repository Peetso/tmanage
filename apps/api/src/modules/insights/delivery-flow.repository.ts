import { WORK_ITEM_STATES, isWorkItemState } from '@tmanage/domain';
import type { Audience, WorkItemState } from '@tmanage/domain';
import { logUnrecognisedRowState } from '../../common/observability/logger.js';
import { MAX_PAGE_SIZE } from '../work/work-items.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS-01's read seam — the delivery-flow roll-up.
 *
 * A project's delivery flow is the count of its work items in each workflow status
 * (`23-ERD-AND-STATE-MACHINES` §5's lifecycle). It is deliberately distinct from x86's
 * project-health roll-up, which counts `on_track`/`at_risk`/`blocked` — this counts the raw
 * lifecycle states themselves (`backlog … archived`), the movement of work through the board.
 *
 * ## Read-only over `work` data
 *
 * This repository owns no table. It reuses {@link WorkItemsRepository.list} read-only — the same
 * tenant-scoped, project-filtered, keyset-paginated query the work reads run — and tallies its
 * rows. It never edits the `work` module (x88 owns work edits) and adds no column of its own: a
 * pure read, computed on demand, no schedule.
 *
 * ## Tenancy is enforced twice, and the count is exact
 *
 * {@link WorkItemsRepository.list} scopes every page to `context.organizationId` in SQL, so a
 * cross-tenant row is never returned in production. The {@link DeliveryFlowOptions.keep}
 * predicate is the service's per-row authorization (its `work.read` relation check) applied
 * belt-and-braces on top of that scope, exactly as `WorkItemsService` applies `mayRead` to each
 * listed row — so a row the caller may not read never contributes to a count. Every project item
 * is visited, page by page, because a count that stops early is a wrong count, not a short one.
 */

/** One tally per workflow status, every status present (zero when none). */
export type DeliveryFlowCounts = Record<WorkItemState, number>;

export interface DeliveryFlowRollup {
  readonly counts: DeliveryFlowCounts;
  /** The readable items counted — the sum of {@link counts}. Zero for an empty project. */
  readonly itemCount: number;
}

export interface DeliveryFlowOptions {
  /**
   * Restrict the underlying read to these audiences. Omitted returns every audience, which is
   * only ever correct for an internal reader; a client projection must pass the allowlist.
   */
  readonly audiences?: readonly Audience[];
  /**
   * A per-row filter the service supplies — its principal-level authorization. A row for which
   * this returns `false` is skipped and does not contribute. Omitted, every row is kept.
   */
  readonly keep?: (row: WorkItemRow) => boolean;
}

/** The documented empty value: every workflow status present, all zero. */
export function emptyDeliveryFlowCounts(): DeliveryFlowCounts {
  const counts = {} as Record<WorkItemState, number>;
  for (const state of WORK_ITEM_STATES) counts[state] = 0;
  return counts;
}

export class DeliveryFlowRepository {
  constructor(private readonly workItems: WorkItemsRepository) {}

  /**
   * Tally a project's readable work items by workflow status.
   *
   * The walk is {@link WorkItemsRepository.list}'s: id-ordered pages, each row kept only if
   * {@link DeliveryFlowOptions.keep} allows it, until a short page ends the project. A row whose
   * persisted `state` is not a known lifecycle state is logged and skipped rather than counted —
   * the state machine is the authority on what a status is, and a count must not invent one.
   */
  async deliveryFlow(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    options: DeliveryFlowOptions = {},
  ): Promise<DeliveryFlowRollup> {
    const keep = options.keep ?? (() => true);
    const counts = emptyDeliveryFlowCounts();
    let itemCount = 0;
    let after: string | undefined;

    for (;;) {
      const page = await this.workItems.list(runner, context, {
        projectId,
        ...(options.audiences ? { audiences: options.audiences } : {}),
        ...(after === undefined ? {} : { after }),
        limit: MAX_PAGE_SIZE,
      });

      for (const row of page) {
        if (!keep(row)) continue;
        if (!isWorkItemState(row.state)) {
          logUnrecognisedRowState('work_item', row.id, context.correlationId);
          continue;
        }
        counts[row.state] += 1;
        itemCount += 1;
      }

      const last = page[page.length - 1];
      if (page.length < MAX_PAGE_SIZE || last === undefined) break;
      after = last.id;
    }

    return { counts, itemCount };
  }
}
