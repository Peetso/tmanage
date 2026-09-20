import type { Audience, WorkItemState } from '@tmanage/domain';
import { MAX_PAGE_SIZE, WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * WK-06's storage half — and, like the timeline's, it owns no storage of its own.
 *
 * The Workload view is a *view*, not a table: `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work
 * WK-06 asks for a project's open work grouped by who carries it, and every fact it needs is
 * already stored on `work_items` — its `owner_user_id` (WORK-001), its lifecycle `state`, and
 * its `start_at`/`due_at`. So this repository *composes* {@link WorkItemsRepository.list} the way
 * {@link WorkTimelineRepository} does, adding no third read and no migration, and staying disjoint
 * from the work module x88 edits in parallel.
 *
 * ## What it borrows, and what it leaves to the service
 *
 * `listOpenProjectItems` walks the project's open work items in the repository's id order — the
 * same tenant-scoped, project-filtered, soft-delete-excluding query the list screen runs — page by
 * page to the end. It applies **no policy**: `mayRead` and the grouping/ordering are the service's,
 * exactly as {@link WorkItemsService} keeps `authorize()` out of its repository. A page that stops
 * early is a wrong workload (an owner short of items), not a short one, so the whole project is
 * visited.
 *
 * The one shaping decision it *does* carry is the "open" filter: it asks the underlying list for the
 * open states only, so a project's completed and archived work never inflates a workload count. That
 * is a `states` argument to the same query, not a policy — the service still supplies the client
 * audience allowlist and drops anything `mayRead` refuses.
 */
export interface ListOpenProjectItemsOptions {
  /**
   * Restrict to these audiences before the query runs — the client allowlist. Omitting it
   * returns every audience, which is only ever correct for an internal reader; the service
   * supplies the allowlist for a client principal exactly as {@link WorkItemsService.list} does.
   */
  readonly audiences?: readonly Audience[];
}

export class WorkloadRepository {
  constructor(private readonly workItems: WorkItemsRepository = new WorkItemsRepository()) {}

  /**
   * Every open work item in the project, in the repository's id order, before any per-row
   * authorization. Tenant-scoped and open-state-filtered by the underlying `list`; grouped,
   * counted and authorized by the service, not here.
   */
  async listOpenProjectItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    openStates: readonly WorkItemState[],
    options: ListOpenProjectItemsOptions = {},
  ): Promise<readonly WorkItemRow[]> {
    const collected: WorkItemRow[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.workItems.list(runner, context, {
        projectId,
        states: openStates,
        ...(options.audiences === undefined ? {} : { audiences: options.audiences }),
        ...(after === undefined ? {} : { after }),
        limit: MAX_PAGE_SIZE,
      });

      for (const item of page) collected.push(item);

      const last = page[page.length - 1];
      if (page.length < MAX_PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    return collected;
  }
}
