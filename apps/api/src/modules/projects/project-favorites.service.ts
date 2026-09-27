import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ProjectRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectFavoritesRepository } from './project-favorites.repository.js';

/**
 * PROJ project favorites (x268) — a member stars a project they can read for their quick personal
 * switcher, unstars it, reads their favorite status of one project, and lists their own favorites. A
 * per-membership surface kept in its own table `project_favorites` and its own module, so it touches
 * no file another projects slice appends to.
 *
 * ## The two authorization layers
 *
 * The route guard asks the coarse `work.read` question a guard can answer with no object loaded —
 * every favorite route is `work.read`, because a member favorites a project they may *read*. This
 * service adds the object-level decision with the project's row in hand: it resolves the project
 * **tenant-scoped before** it authorizes (the Known-trap order — `ProjectObjectivesService`), so a
 * missing id, or one that belongs to another tenant, is a **404**, never a foreign-key 500 reached by
 * an org-wide caller who would pass the relation check regardless. A project the caller may not read
 * is also 404, never 403 — a 403 would confirm the project exists, which a non-member must not probe.
 *
 * A favorite is always the caller's own: every write and the list are scoped to
 * `context.membershipId`, so a member can never create, remove, or read another member's favorites
 * even inside the same tenant.
 */

/**
 * What a caller sees of one favorited project — paired Exact with the web's `ProjectFavoriteSummary`.
 * `organizationId`/`membershipId` are deliberately absent — the wire projection never echoes the
 * tenant id (`25-AUTH` §7), and the membership is always the caller's own.
 */
export interface ProjectFavoriteView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  /** ISO-8601 instant. */
  readonly createdAt: string;
}

export class ProjectFavoritesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projectsRepo: ProjectsRepository = new ProjectsRepository(),
    private readonly favorites: ProjectFavoritesRepository = new ProjectFavoritesRepository(),
  ) {}

  /**
   * Resolve a project the principal may read, tenant-scoped **before** the relation check. A
   * missing/cross-tenant id, or one the caller may not read, is 404 — never 403, never 500. Returns
   * the row so a caller can build the view without a second read.
   */
  private async requireReadable(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectRow> {
    const row = await this.database.read(context, (runner) =>
      this.projectsRepo.findById(runner, context, projectId),
    );

    const permitted =
      row !== null &&
      authorize({
        principal,
        capability: 'work.read',
        resource: {
          organizationId: row.organizationId,
          projectId: row.id,
          audience: 'internal',
          lifecycle: 'active',
        },
      }).allowed;

    if (!row || !permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    return row;
  }

  /** Whether the caller has favorited a project they can read. */
  async status(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<{ readonly favorited: boolean }> {
    await this.requireReadable(context, principal, projectId);
    const existing = await this.database.read(context, (runner) =>
      this.favorites.find(runner, context, projectId, context.membershipId),
    );
    return { favorited: existing !== null };
  }

  /**
   * Favorite a project for the caller, idempotently. A repeated PUT returns the same view, never a
   * second row. The project is resolved readable first (Known-trap 404 order).
   */
  async add(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectFavoriteView> {
    const project = await this.requireReadable(context, principal, projectId);
    const row = await this.database.transaction(context, (tx) =>
      this.favorites.add(tx, context, { projectId, membershipId: context.membershipId }),
    );
    return {
      id: row.id,
      projectId: row.projectId,
      name: project.name,
      status: project.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Remove the caller's favorite of a project, idempotently (no favorite → still success). */
  async remove(context: TenantContext, principal: Principal, projectId: string): Promise<void> {
    await this.requireReadable(context, principal, projectId);
    await this.database.transaction(context, (tx) =>
      this.favorites.remove(tx, context, projectId, context.membershipId),
    );
  }

  /**
   * List the caller's favorites, newest first, projected to the projects they can **still** read. A
   * favorited project the caller has since lost read access to is dropped, so the switcher never
   * leaks a name the caller may no longer see.
   */
  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ProjectFavoriteView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.favorites.listForMember(runner, context, context.membershipId),
    );
    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: context.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map((row) => ({
        id: row.id,
        projectId: row.projectId,
        name: row.name,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      }));
  }
}
