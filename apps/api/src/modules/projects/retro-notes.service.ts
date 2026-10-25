import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectRetroNotesRepository } from './retro-notes.repository.js';
import type { ProjectRetroNoteCategory } from './retro-notes.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import { PROJECT_RETRO_NOTE_CATEGORIES } from '../../common/database/schema.js';
import type { ProjectRetroNoteRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x311) — a project's retrospective-notes log. It follows
 * the `ProjectStatusUpdatesService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage`. This service adds the
 * **relation** check with the row's project in hand: a member without organization-wide scope reads,
 * captures and deletes notes only on the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names `projectId` by id, and the composite foreign key would surface an unknown or
 * cross-tenant id as a foreign-key 500 the `HttpExceptionFilter` cannot map. So the project the
 * request names is resolved **tenant-scoped before the relation check and the write**: an unknown or
 * another tenant's id is a 404, never a 500, and the relation failure is a 404 too (a 403 would
 * confirm the project exists to a caller who is not a member). An optional `milestoneId` is resolved
 * the same way and must belong to the named project — an unknown or foreign milestone is a 400 with
 * nothing written.
 */

/** What a caller is allowed to see of a retro note. `organizationId` is deliberately absent. */
export interface ProjectRetroNoteView {
  readonly id: string;
  readonly projectId: string;
  readonly milestoneId: string | null;
  readonly category: ProjectRetroNoteCategory;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The retro board: notes grouped by category, each group newest-first. */
export interface ProjectRetroBoardView {
  readonly wentWell: readonly ProjectRetroNoteView[];
  readonly toImprove: readonly ProjectRetroNoteView[];
  readonly action: readonly ProjectRetroNoteView[];
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). `organization_id`
 * is never echoed into a response body.
 */
function toView(row: ProjectRetroNoteRow): ProjectRetroNoteView {
  return {
    id: row.id,
    projectId: row.projectId,
    milestoneId: row.milestoneId ?? null,
    category: row.category,
    body: row.body,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ProjectRetroNotesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly notes: ProjectRetroNotesRepository = new ProjectRetroNotesRepository(),
    /**
     * Read-only, used to prove the project a note names exists **inside this tenant** before the
     * insert is attempted, mapping an unknown/cross-tenant id to 404 rather than a foreign-key 500.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /** Read-only, used to resolve an optional `milestoneId` tenant-scoped (unknown ⇒ 400). */
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
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
   * List a project's retro notes the principal may manage, grouped by category, each group
   * newest-first. The project is resolved manage-visible first (Known-trap).
   */
  async list(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectRetroBoardView> {
    await this.requireManageableProject(context, principal, projectId);

    const rows = await this.database.read(context, (runner) =>
      this.notes.listByProject(runner, context, projectId),
    );
    const views = rows.map(toView);
    return {
      wentWell: views.filter((note) => note.category === 'went_well'),
      toImprove: views.filter((note) => note.category === 'to_improve'),
      action: views.filter((note) => note.category === 'action'),
    };
  }

  /**
   * Capture a retro note against a project the principal may manage.
   *
   * The project is resolved manage-visible first (Known-trap). An optional `milestoneId` is then
   * resolved tenant-scoped and must belong to the named project; an unknown or foreign milestone is a
   * 400 with nothing written. Then the write.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly milestoneId: string | null;
      readonly category: ProjectRetroNoteCategory;
      readonly body: string;
    },
  ): Promise<ProjectRetroNoteView> {
    await this.requireManageableProject(context, principal, input.projectId);

    if (input.milestoneId !== null) {
      const milestone = await this.database.read(context, (runner) =>
        this.milestones.findById(runner, context, input.milestoneId as string),
      );
      if (!milestone || milestone.projectId !== input.projectId) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'milestoneId', message: 'must reference a milestone of this project' },
        ]);
      }
    }

    const row = await this.database.transaction(context, (tx) =>
      this.notes.create(tx, context, {
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        category: input.category,
        body: input.body,
        createdBy: context.userId,
      }),
    );
    return toView(row);
  }

  /**
   * Delete one retro note, idempotently (204). The project is resolved manage-visible first
   * (Known-trap), then the delete predicate carries `(organization_id, project_id, id)`, so a note that
   * does not exist, belongs to another tenant, or belongs to another project (F29) removes nothing and
   * still returns 204.
   */
  async delete(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    noteId: string,
  ): Promise<void> {
    await this.requireManageableProject(context, principal, projectId);

    await this.database.transaction(context, (tx) =>
      this.notes.deleteById(tx, context, projectId, noteId),
    );
  }
}

/** Re-exported so the controller can validate against the same allowlist the schema defines. */
export { PROJECT_RETRO_NOTE_CATEGORIES };
