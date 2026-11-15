import type { ClientProjectionRow, ProjectMilestoneRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';

export interface PortalJourneySources {
  /** Published milestones only, in timeline order (`due_on` ascending, undated last). */
  readonly milestones: readonly ProjectMilestoneRow[];
  /** Published versions of live deliverables, newest first. */
  readonly versions: readonly ClientProjectionRow[];
}

/**
 * 52-27 — the two client-safe sources a journey is derived from, read on one tenant runner.
 *
 * It owns no SQL of its own: both reads already carry the tenant predicate and the client gate
 * (`published = 1` for milestones; a projection row exists only once a version is published), so
 * the journey reuses them instead of restating either.
 */
export class PortalJourneyRepository {
  constructor(
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
    private readonly projections: ClientProjectionsRepository = new ClientProjectionsRepository(),
  ) {}

  async sources(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<PortalJourneySources> {
    const milestones = await this.milestones.list(runner, context, {
      projectId,
      publishedOnly: true,
    });
    const versions = await this.projections.listByProject(runner, context, projectId);
    return { milestones, versions };
  }
}
