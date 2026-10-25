import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectDependenciesRepository } from './dependencies.repository.js';
import type { ProjectDependencyWithProject } from './dependencies.repository.js';

/**
 * The application service for PROJ / cross-project dependencies (x309) — the directed edge one
 * project may record against another that the route guard cannot decide. It follows the
 * `MilestoneLinksService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question — `project.manage`: does this role's
 * ceiling include the capability at all. This service adds the **relation** check with the path
 * project in hand: a member without organization-wide scope creates, lists and removes dependencies
 * only for the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names a project id in the path — and on create, the body's other project id. **BOTH
 * are resolved tenant-scoped BEFORE the relation check and the write**: an unknown or another
 * tenant's id is a 404, never a foreign-key 500, and the relation failure is a 404 too (a 403 would
 * confirm the row exists to a caller who is not a member). Only then the invariants: a
 * self-dependency is rejected (400), and a duplicate pair is a 409.
 */

const MAX_NOTE_LENGTH = 500;

/** What a caller is allowed to see of one dependency neighbour. `organizationId` is absent. */
export interface ProjectDependencyView {
  readonly edgeId: string;
  readonly blockerProjectId: string;
  readonly blockedProjectId: string;
  /** The name of the neighbouring project this edge points at (from the caller's perspective). */
  readonly projectName: string;
  readonly projectStatus: string;
  readonly note: string | null;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

/** A project's two dependency lists: what it blocks, and what blocks it. */
export interface ProjectDependencyGraph {
  readonly blocking: readonly ProjectDependencyView[];
  readonly blockedBy: readonly ProjectDependencyView[];
}

export class ProjectDependenciesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly dependencies: ProjectDependenciesRepository = new ProjectDependenciesRepository(),
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * List a project's dependency graph — the projects it blocks and the projects that block it —
   * both in creation order. The path project is resolved manage-visible first (Known-trap): an
   * unknown or cross-tenant `projectId` and a non-member's probe both earn the same not-found.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<ProjectDependencyGraph> {
    await this.requireManageableProject(context, principal, options.projectId);

    const [blocking, blockedBy] = await Promise.all([
      this.database.read(context, (runner) =>
        this.dependencies.listBlocking(runner, context, options.projectId, options.limit),
      ),
      this.database.read(context, (runner) =>
        this.dependencies.listBlockedBy(runner, context, options.projectId, options.limit),
      ),
    ]);

    // F49. An edge discloses the far-end project's name and status, so it is listed only when the
    // principal may read that project; an edge to a project they cannot see is omitted entirely.
    return {
      blocking: blocking
        .filter((row) =>
          mayReadProject(context, principal, row.edge.blockedProjectId, row.projectArchivedAt),
        )
        .map((row) => this.toView(row)),
      blockedBy: blockedBy
        .filter((row) =>
          mayReadProject(context, principal, row.edge.blockerProjectId, row.projectArchivedAt),
        )
        .map((row) => this.toView(row)),
    };
  }

  /**
   * Record that the path project blocks another (the other project depends on it).
   *
   * BOTH ids are resolved tenant-scoped BEFORE the write (Known-trap): the path project is resolved
   * manage-visible; the blocked project is resolved inside the tenant and must pass `work.read` for
   * the principal (F49), else the same not-found. Then
   * the invariants — a self-dependency (400) — and finally the write, which is a 409 on a duplicate
   * pair.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly blockerProjectId: string;
      readonly blockedProjectId: string;
      readonly note?: string | null;
    },
  ): Promise<ProjectDependencyView> {
    await this.requireManageableProject(context, principal, input.blockerProjectId);

    // A dependency to itself is meaningless — reject before resolving the far end.
    if (input.blockerProjectId === input.blockedProjectId) {
      throw new ApiError(
        400,
        'validation_failed',
        'A project cannot depend on itself',
        [{ field: 'blockedProjectId', message: 'must differ from the project' }],
        'self_dependency',
      );
    }

    const note = normaliseNote(input.note);

    const blocked = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, input.blockedProjectId),
    );
    // A project in another tenant is already null; an unknown id is a 404, never a foreign-key 500.
    // F49. A project the principal may not read earns the same 404: no edge is written onto it and
    // neither its name nor its status is echoed, and the answer is no existence oracle.
    if (!blocked || !mayReadProject(context, principal, blocked.id, blocked.archivedAt)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    // A duplicate pair is a conflict, not a second row.
    const existing = await this.database.read(context, (runner) =>
      this.dependencies.findByPair(runner, context, input.blockerProjectId, input.blockedProjectId),
    );
    if (existing) {
      throw new ApiError(
        409,
        'conflict',
        'This dependency already exists',
        undefined,
        'duplicate_dependency',
      );
    }

    const row = await this.database.transaction(context, (tx) =>
      this.dependencies.create(tx, context, {
        blockerProjectId: input.blockerProjectId,
        blockedProjectId: input.blockedProjectId,
        note,
        createdBy: context.userId,
      }),
    );

    return this.toView({ edge: row, projectName: blocked.name, projectStatus: blocked.status });
  }

  /**
   * Remove a dependency by its (blocker, blocked) pair.
   *
   * The path (blocker) project is resolved manage-visible first (Known-trap): an unknown or
   * cross-tenant id, and a non-member's probe, are each a 404 with no write. The unlink is
   * idempotent — a pair that is not linked is a no-op — so the route is a clean 204 either way.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    blockerProjectId: string,
    blockedProjectId: string,
  ): Promise<void> {
    await this.requireManageableProject(context, principal, blockerProjectId);

    const existing = await this.database.read(context, (runner) =>
      this.dependencies.findByPair(runner, context, blockerProjectId, blockedProjectId),
    );
    if (!existing) return;

    await this.database.transaction(context, (tx) =>
      this.dependencies.deleteById(tx, context, existing.id),
    );
  }

  /**
   * Resolve a project the principal may manage, tenant-scoped and relation-gated, or throw the
   * not-found that both an unknown id and a non-member's probe must earn. Returns the project row.
   */
  private async requireManageableProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectRow> {
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
        organizationId: project.organizationId,
        projectId: project.id,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    return project;
  }

  private toView(row: ProjectDependencyWithProject): ProjectDependencyView {
    return {
      edgeId: row.edge.id,
      blockerProjectId: row.edge.blockerProjectId,
      blockedProjectId: row.edge.blockedProjectId,
      projectName: row.projectName,
      projectStatus: row.projectStatus,
      note: row.edge.note ?? null,
      createdAt: row.edge.createdAt.toISOString(),
    };
  }
}

/**
 * F49. Whether the principal may read a far-end project (`work.read`, relation-gated), the same rule
 * `ProjectsService.list` applies. Used before any of that project's fields leave the service.
 */
function mayReadProject(
  context: TenantContext,
  principal: Principal,
  projectId: string,
  archivedAt: Date | null | undefined,
): boolean {
  return authorize({
    principal,
    capability: 'work.read',
    resource: {
      organizationId: context.organizationId,
      projectId,
      audience: 'internal',
      lifecycle: archivedAt ? 'archived' : 'active',
    },
  }).allowed;
}

/**
 * Trim a note to null when empty, or reject one over the column length (400). The column is
 * `VARCHAR(500)`; validating here keeps the error a clean 400 rather than a truncation or a driver
 * error.
 */
function normaliseNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  if (trimmed === '') return null;
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: `must be at most ${MAX_NOTE_LENGTH} characters` },
    ]);
  }
  return trimmed;
}
