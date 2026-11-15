import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { deriveJourney } from './portal-journey.js';
import type { PortalJourney } from './portal-journey.js';
import { PortalJourneyRepository } from './portal-journey.repository.js';

/**
 * 52-27 — the client's journey through one project.
 *
 * The project id comes from the path, so the relation check runs **before** any read: for a
 * client, `authorize()` rule 10 admits only projects in `principal.projectIds` (from
 * `project_clients`), so another client's project, a cross-tenant id or an unknown id all fail
 * it and answer the same `404` — a probe learns nothing. The tenant is the session's context.
 */
export class PortalJourneyService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly sources: PortalJourneyRepository = new PortalJourneyRepository(),
  ) {}

  async forProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<PortalJourney> {
    const permitted = authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const { milestones, versions } = await this.database.read(context, (runner) =>
      this.sources.sources(runner, context, projectId),
    );
    return deriveJourney(projectId, milestones, versions);
  }
}
