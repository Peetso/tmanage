import type { Audience } from '@tmanage/domain';
import { MAX_PAGE_SIZE, WorkItemsRepository } from '../work/work-items.repository.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * WK-05's storage half — and, like the timeline's, it owns no storage of its own.
 *
 * The Work calendar is a *view*, not a table: `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work
 * WK-05 asks for a calendar of a project's work, and every fact it needs is already stored and
 * already read. `work_items` carries `start_at`/`due_at` (WORK-001), so this repository
 * *composes* {@link WorkItemsRepository.list} — the same tenant-scoped, project-filtered,
 * soft-delete-excluding read the list and timeline screens run — rather than adding a calendar
 * table or a third read. No migration, and disjoint from the work module, exactly as
 * {@link WorkTimelineRepository} composes its borrowed reads (x94).
 *
 * ## What it composes, and what it deliberately does not
 *
 * `listProjectItems` walks the project's work items in the repository's own id order, page by
 * page to the end. It applies **no policy** and **no bucketing**: `mayRead`, the client-audience
 * belt-and-braces, the date bucketing and the deterministic order are all the service's, exactly
 * as `WorkItemsService` keeps `authorize()` out of its repository. A page that stops early is a
 * wrong calendar, not a short one, so the whole project is visited.
 */

export interface ListProjectItemsOptions {
  /**
   * Restrict to these audiences before the query runs — the client allowlist. Omitting it
   * returns every audience, which is only ever correct for an internal reader; the service
   * supplies the allowlist for a client principal exactly as {@link WorkItemsService.list} does.
   */
  readonly audiences?: readonly Audience[];
}

export class WorkCalendarRepository {
  constructor(private readonly workItems: WorkItemsRepository = new WorkItemsRepository()) {}

  /**
   * Every work item in the project, in the repository's id order. Tenant-scoped by the
   * underlying `list`; bucketed by date and authorized by the service, not here.
   */
  async listProjectItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    options: ListProjectItemsOptions = {},
  ): Promise<readonly WorkItemRow[]> {
    const collected: WorkItemRow[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.workItems.list(runner, context, {
        projectId,
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
