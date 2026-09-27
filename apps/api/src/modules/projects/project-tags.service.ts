import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ProjectTagRow } from '../../common/database/schema.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectTagsRepository } from './project-tags.repository.js';

/**
 * x267's application service — project tags / labels (Projects / portfolio module).
 *
 * Two objects, one table (see `0137_project_tags.sql`): a **tag definition** the studio owns, and a
 * **tag assignment** tying a definition to a project. It follows `WorkLabelsService` (x233) and
 * `ProjectObjectivesService` (x124):
 *
 * ## Definitions are org-scoped; assignments resolve the project first
 *
 * Defining and listing tags is org-wide, gated by the coarse route capability alone (`project.manage`
 * to define, `work.read` to list): there is no specific project to relation-check, so the service
 * adds no `authorize()` there. A name is unique per tenant — a collision is a 409.
 *
 * ## Resolve the project AND the tag, tenant-scoped, BEFORE authorizing or writing (Known-trap)
 *
 * Assign / remove / list-for-project name a `projectId` in the path; the project is read first,
 * scoped to the acting tenant — a cross-tenant or unknown `projectId` does not resolve and is a 404,
 * before `authorize()` is asked and before any write, never a foreign-key 500. It is then
 * relation-gated (`project.manage` to assign/remove, `work.read` to list): a caller who is not
 * related to the project earns the same 404, not a 403 that would confirm the project exists (the
 * coarse `CapabilityGuard` on the route has already produced the 403 for a role without the ceiling
 * at all). The tag id is resolved the same way: a tag of another studio does not resolve and is a
 * 404. Tagging is idempotent: assigning a tag already on the project returns the existing assignment.
 */

/** The client-facing projection of one tag definition. Paired in `apps/web`. */
export interface ProjectTagView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The client-facing projection of one tag assigned to a project. Paired in `apps/web`. */
export interface ProjectTagAssignmentView {
  readonly id: string;
  readonly projectId: string;
  readonly tagId: string;
  readonly name: string;
  readonly createdAt: string;
}

export class ProjectTagsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly tags: ProjectTagsRepository = new ProjectTagsRepository(),
    /**
     * Read-only, used to prove the project a tag assignment names exists **inside this tenant**
     * before the write, exactly as `ProjectObjectivesService` does. The composite foreign key already
     * refuses another tenant's project, but it surfaces as a 500; a pre-resolution turns a missing or
     * cross-tenant `projectId` into a 404.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /** The tenant's tag definitions, name-ascending. Behind `work.read` (the route's coarse ceiling). */
  async listDefinitions(context: TenantContext): Promise<readonly ProjectTagView[]> {
    return this.database.read(context, async (runner) => {
      const rows = await this.tags.listDefinitions(runner, context);
      return rows.map(toTagView);
    });
  }

  /** Define a tag. Behind `project.manage`. Duplicate name → 409. */
  async define(context: TenantContext, name: string): Promise<ProjectTagView> {
    const trimmed = requiredName(name);
    return this.database.transaction(context, async (tx) => {
      const clash = await this.tags.findDefinitionByName(tx, context, trimmed);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A tag with this name already exists');
      }
      const row = await this.tags.createDefinition(tx, context, trimmed);
      return toTagView(row);
    });
  }

  /** The tags assigned to a project. Behind `work.read` on the resolved project. */
  async listForProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectTagAssignmentView[]> {
    return this.database.read(context, async (runner) => {
      await this.requireVisibleProject(runner, context, principal, projectId, 'work.read');
      const [assignments, definitions] = await Promise.all([
        this.tags.listAssignments(runner, context, projectId),
        this.tags.listDefinitions(runner, context),
      ]);
      const byId = new Map(definitions.map((row) => [row.id, row]));
      return assignments
        .map((assignment) => toAssignmentView(assignment, byId.get(assignment.tagId ?? '')))
        .filter((view): view is ProjectTagAssignmentView => view !== null);
    });
  }

  /** Tag a project with a tag. Behind `project.manage`. Idempotent; unknown tag/project → 404. */
  async assign(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    tagId: string,
  ): Promise<ProjectTagAssignmentView> {
    return this.database.transaction(context, async (tx) => {
      await this.requireVisibleProject(tx, context, principal, projectId, 'project.manage');

      // The tag is resolved scoped to the tenant; a cross-tenant or unknown tag id does not resolve
      // and is a 404, before any write.
      const definition = await this.tags.findDefinition(tx, context, tagId);
      if (!definition) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // Idempotent: an already-present tag returns its existing row rather than a duplicate.
      const existing = await this.tags.findAssignment(tx, context, projectId, tagId);
      const row = existing ?? (await this.tags.createAssignment(tx, context, projectId, tagId));
      const view = toAssignmentView(row, definition);
      if (!view) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return view;
    });
  }

  /** Untag a project. Behind `project.manage`. A tag that is not present is a no-op 204. */
  async remove(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    tagId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.requireVisibleProject(tx, context, principal, projectId, 'project.manage');
      await this.tags.deleteAssignment(tx, context, projectId, tagId);
    });
  }

  /**
   * Resolve a project the principal may act on under `capability`, tenant- and relation-scoped, or
   * throw the not-found that both an unknown/cross-tenant id and a non-member's probe must earn. The
   * resolution runs on the caller's runner so it shares the assign/remove transaction.
   */
  private async requireVisibleProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: 'project.manage' | 'work.read',
  ): Promise<void> {
    const project = await this.projects.findById(runner, context, projectId);
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    const permitted = authorize({
      principal,
      capability,
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
}

function toTagView(row: ProjectTagRow): ProjectTagView {
  return {
    id: row.id,
    name: row.name ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

/** An assignment row plus its definition; `null` if the definition is missing (never, in practice). */
function toAssignmentView(
  assignment: ProjectTagRow,
  definition: ProjectTagRow | undefined,
): ProjectTagAssignmentView | null {
  if (!definition || assignment.projectId === null || assignment.tagId === null) return null;
  return {
    id: assignment.id,
    projectId: assignment.projectId,
    tagId: assignment.tagId,
    name: definition.name ?? '',
    createdAt: assignment.createdAt.toISOString(),
  };
}

function requiredName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  const name = raw.trim();
  if (name.length > 120) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be 120 characters or fewer' },
    ]);
  }
  return name;
}
