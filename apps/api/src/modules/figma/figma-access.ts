import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FigmaLinkRow, ProjectRow } from '../../common/database/schema.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { ReviewFrameGate, ReviewFrameSubject } from '../files/review.service.js';
import { FigmaRepository, type FigmaLinkAudience } from './figma.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R4 slice 13 — who may read a Figma link, in one place: the Figma service's routes and the
 * review service's threads on frames (it is the review service's {@link ReviewFrameGate}) ask
 * the same question and get the same answer.
 *
 * Staff: `file.download` on the link's project at the link's audience. A client: only a
 * `client_visible` link, on a project that is not archived, that its `client_projection.read`
 * reaches (the portal's own `mayRead`). A removed link, a link of another tenant, and anything
 * refused are the one 404.
 */
export class FigmaAccess implements ReviewFrameGate {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: FigmaRepository = new FigmaRepository(),
    private readonly projects: Pick<ProjectsRepository, 'findById'> = new ProjectsRepository(),
  ) {}

  async readableLink(
    context: TenantContext,
    principal: Principal,
    linkId: string,
  ): Promise<{ readonly link: FigmaLinkRow; readonly project: ProjectRow }> {
    if (!UUID.test(linkId)) throw notFound();
    const found = await this.database.read(context, async (runner) => {
      const link = await this.repository.findLink(runner, context, linkId);
      if (!link) return null;
      const project = await this.projects.findById(runner, context, link.projectId);
      return project ? { link, project } : null;
    });
    if (!found) throw notFound();
    const { link, project } = found;
    if (principal.kind === 'client') {
      if (link.audience !== 'client_visible' || project.archivedAt !== null) throw notFound();
      if (!clientMayRead(principal, link.projectId)) throw notFound();
      return found;
    }
    const allowed = authorize({
      principal,
      capability: 'file.download',
      resource: {
        organizationId: project.organizationId,
        projectId: project.id,
        audience: link.audience as FigmaLinkAudience,
        clientOrganizationId: null,
        lifecycle: project.archivedAt === null ? 'active' : 'archived',
      },
    }).allowed;
    if (!allowed) throw notFound();
    return found;
  }

  async resolveFrame(
    context: TenantContext,
    principal: Principal,
    frameId: string,
  ): Promise<ReviewFrameSubject | null> {
    if (!UUID.test(frameId)) return null;
    const frame = await this.database.read(context, (runner) =>
      this.repository.findFrame(runner, context, frameId),
    );
    if (!frame) return null;
    try {
      const { link, project } = await this.readableLink(context, principal, frame.linkId);
      return {
        frameId: frame.id,
        organizationId: link.organizationId,
        projectId: link.projectId,
        audience: link.audience as FigmaLinkAudience,
        archived: project.archivedAt !== null,
      };
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

/** `client_projection.read` on the project — the portal's own `mayRead`. */
export function clientMayRead(principal: Principal, projectId: string): boolean {
  return authorize({
    principal,
    capability: 'client_projection.read',
    resource: {
      organizationId: principal.organizationId,
      projectId,
      audience: 'client_visible',
      clientOrganizationId: principal.clientOrganizationId,
      lifecycle: 'active',
    },
  }).allowed;
}
