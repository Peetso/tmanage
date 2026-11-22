import type { Audience, WorkItemState } from '@tmanage/domain';
import { and, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberships } from '../../common/database/schema.js';
import type { ProjectRow, WorkItemRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';

/**
 * x134's storage half — the workload-forecast read, and like INS-05's roll-up it owns no storage of
 * its own.
 *
 * The forecast is a *view*, not a table: `38-MODULE-MAP` §Insights (forecasting) asks to project the
 * open, dated work already on `work_items` into the upcoming weeks, and every fact it needs — a work
 * item's lifecycle `state`, its `due_at`, its `owner_user_id` — is already stored there. So this
 * repository composes the two tenant-scoped reads INS-05 already composes ({@link
 * ProjectsRepository.list} to enumerate the tenant's projects, {@link
 * WorkloadRepository.listOpenProjectItems} to walk one project's open work to the end), adding no
 * third read, no new column and no migration.
 *
 * It applies **no policy**. `authorize()`, the week bucketing and the capacity comparison are the
 * service's, exactly as {@link InsightsService} keeps `authorize()` out of its repositories: the
 * enumeration is tenant-scoped in SQL, and the service is the one place that re-checks each project
 * and each row against the caller before it enters the forecast. The service also decides *whether*
 * to read a project's items at all (it skips the ones the caller may not read), so this repository
 * never fans a read out for a project the service has already refused.
 */
export class WorkloadForecastRepository {
  constructor(
    /** Read-only, used only to enumerate the tenant's projects (tenant-scoped in SQL). */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /** Reused as-is from x99 (WK-06): the per-project open-work read the forecast runs per project. */
    private readonly workload: WorkloadRepository = new WorkloadRepository(),
  ) {}

  /** One tenant's projects, tenant-scoped and bounded — the set the forecast walks. */
  async listProjects(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: { readonly limit?: number } = {},
  ): Promise<readonly ProjectRow[]> {
    return this.projects.list(runner, context, {
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  /**
   * Every open work item in the project, tenant-scoped and open-state-filtered by the underlying
   * read, before any per-row authorization — grouped, bucketed and authorized by the service.
   */
  async listOpenProjectItems(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    openStates: readonly WorkItemState[],
    options: { readonly audiences?: readonly Audience[] } = {},
  ): Promise<readonly WorkItemRow[]> {
    return this.workload.listOpenProjectItems(runner, context, projectId, openStates, {
      ...(options.audiences === undefined ? {} : { audiences: options.audiences }),
    });
  }

  /**
   * 60-09: the users of the tenant's AI employees. Their open work is still counted, but they add
   * no capacity: the forecast's "members" are people only.
   */
  async aiUserIds(runner: TenantQueryRunner, context: TenantContext): Promise<ReadonlySet<string>> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(eq(memberships.organizationId, context.organizationId), eq(memberships.kind, 'ai')),
      );
    return new Set(rows.map((row) => row.userId));
  }
}
