import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectStatusUpdatesRepository } from './status-updates.repository.js';
import type { ProjectStatusBand } from './status-updates.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectStatusUpdateRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x235) — the internal project status-update log's
 * object-level decisions. It follows the `ProjectRiskRegisterService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage` — this log is the studio's
 * own status changelog, posted and read by the people who manage the project. This service adds the
 * **relation** check with the row's project in hand: a member without organization-wide scope posts
 * and reads only the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names `projectId` by id, and the composite foreign key would surface an unknown or
 * cross-tenant id as a foreign-key 500 the `HttpExceptionFilter` cannot map. So the project the
 * request names is resolved **tenant-scoped before the relation check and the write**: an unknown or
 * another tenant's id is a 404, never a 500, and the relation failure is a 404 too (a 403 would
 * confirm the project exists to a caller who is not a member).
 *
 * ## Internal-only
 *
 * This is the studio's internal status log, distinct from x125's `project_updates` (the clients-module
 * surface that publishes an update to a client's portal). It is never projected to a client — the
 * portal service does not read `project_status_updates`, and this service has no client-facing path.
 */

/** What a caller is allowed to see of a status update. `organizationId` is deliberately absent. */
export interface ProjectStatusUpdateView {
  readonly id: string;
  readonly projectId: string;
  readonly statusBand: ProjectStatusBand;
  readonly body: string;
  readonly postedBy: string;
  readonly postedAt: string;
}

/** The keyset page: the updates newest-first, and the cursor to fetch the next (older) page. */
export interface ProjectStatusUpdatePageView {
  readonly updates: readonly ProjectStatusUpdateView[];
  /** The id to pass as `before` for the next page, or `null` when the log is exhausted. */
  readonly nextCursor: string | null;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). `organization_id`
 * is never echoed into a response body.
 */
function toView(row: ProjectStatusUpdateRow): ProjectStatusUpdateView {
  return {
    id: row.id,
    projectId: row.projectId,
    statusBand: row.statusBand,
    body: row.body,
    postedBy: row.postedBy,
    postedAt: row.postedAt.toISOString(),
  };
}

export class ProjectStatusUpdatesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly updates: ProjectStatusUpdatesRepository = new ProjectStatusUpdatesRepository(),
    /**
     * Read-only, used to prove the project a new update names exists **inside this tenant** before the
     * insert is attempted. The composite foreign key already refuses another tenant's project, but it
     * surfaces as a 500; an organization-wide caller skips the relation gate, so without this
     * pre-resolution a missing or cross-tenant `projectId` would fall through to that foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * Resolve a project the principal may manage, tenant- and relation-scoped, or throw the not-found
   * that both an unknown id and a non-member's probe must earn.
   */
  private async requireManageableProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /**
   * List a project's status updates the principal may manage, newest first, keyset-paged.
   *
   * The project is resolved manage-visible first (Known-trap): an unknown or cross-tenant `projectId`,
   * and a non-member's probe, both earn the same not-found. `nextCursor` is the last id of a full
   * page, or `null` when the page was not full (the log is exhausted).
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number; readonly before?: string },
  ): Promise<ProjectStatusUpdatePageView> {
    await this.requireManageableProject(context, principal, options.projectId);

    const rows = await this.database.read(context, (runner) =>
      this.updates.list(runner, context, options),
    );
    const updates = rows.map(toView);
    const full = options.limit !== undefined ? rows.length >= options.limit : false;
    const last = updates.at(-1);
    return {
      updates,
      nextCursor: full && last ? last.id : null,
    };
  }

  /**
   * Post a status update against a project the principal may manage.
   *
   * The project is resolved manage-visible first (Known-trap): an unknown or cross-tenant `projectId`
   * is a 404, and a caller who names a project they do not manage gets the same not-found rather than
   * a 403 that would confirm the project exists. Then the write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly statusBand: ProjectStatusBand;
      readonly body: string;
    },
  ): Promise<ProjectStatusUpdateView> {
    await this.requireManageableProject(context, principal, input.projectId);

    const row = await this.database.transaction(context, (tx) =>
      this.updates.create(tx, context, {
        projectId: input.projectId,
        statusBand: input.statusBand,
        body: input.body,
        postedBy: context.userId,
      }),
    );
    return toView(row);
  }
}
