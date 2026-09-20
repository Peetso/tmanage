import type { Audience } from '@tmanage/domain';
import { MAX_PAGE_SIZE, WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkGraphRepository } from '../work/work-graph.repository.js';
import type { PredecessorHealthRow } from '../work/work-graph.repository.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * WK-04's storage half — and it owns no storage of its own.
 *
 * The Work timeline is a *view*, not a table: `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Work
 * WK-04 asks for "Milestones/dependencies … accessible list", and every fact it needs is
 * already stored and already read. `work_items` carries `start_at`/`due_at` (WORK-001) and the
 * edges live in `work_item_dependencies`, read publicly through
 * {@link WorkGraphRepository.listPredecessors} (WORK-003). This repository therefore *composes*
 * those two reads rather than adding a third — the read shape NEXT-SCOPES §x94 fixes so this
 * slice stays disjoint from the work module (which x88 is editing in parallel) and adds no
 * migration.
 *
 * ## What it composes, and what it deliberately does not
 *
 * `listProjectTimeline` walks the project's work items in the repository's own id order — the
 * same tenant-scoped, project-filtered, soft-delete-excluding query {@link WorkItemsRepository.list}
 * runs for the list screen — page by page to the end, and for each item reads its predecessors.
 * It applies **no policy**: `mayRead`, the per-predecessor redaction rule and the timeline order
 * are the service's, exactly as `WorkItemsService` keeps `authorize()` out of its repository. A
 * page that stops early is a wrong timeline, not a short one, so the whole project is visited.
 */

/** One project item and the predecessor edges pointing at it, straight from storage — no policy. */
export interface TimelineItemRow {
  readonly item: WorkItemRow;
  readonly predecessors: readonly PredecessorHealthRow[];
}

export interface ListProjectTimelineOptions {
  /**
   * Restrict to these audiences before the query runs — the client allowlist. Omitting it
   * returns every audience, which is only ever correct for an internal reader; the service
   * supplies the allowlist for a client principal exactly as {@link WorkItemsService.list} does.
   */
  readonly audiences?: readonly Audience[];
}

export class WorkTimelineRepository {
  constructor(
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
    private readonly graph: WorkGraphRepository = new WorkGraphRepository(),
  ) {}

  /**
   * Every work item in the project, each paired with its predecessor edges, in the repository's
   * id order. Tenant-scoped by the underlying `list` and `listPredecessors`; ordered for the
   * timeline and authorized by the service, not here.
   */
  async listProjectTimeline(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    options: ListProjectTimelineOptions = {},
  ): Promise<readonly TimelineItemRow[]> {
    const collected: TimelineItemRow[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.workItems.list(runner, context, {
        projectId,
        ...(options.audiences === undefined ? {} : { audiences: options.audiences }),
        ...(after === undefined ? {} : { after }),
        limit: MAX_PAGE_SIZE,
      });

      for (const item of page) {
        const predecessors = await this.graph.listPredecessors(runner, context, item.id);
        collected.push({ item, predecessors });
      }

      const last = page[page.length - 1];
      if (page.length < MAX_PAGE_SIZE || last === undefined) break;
      after = last.id;
    }
    return collected;
  }
}
