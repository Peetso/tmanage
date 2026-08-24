import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import type { CreateProjectInput, ListProjectsOptions } from './projects.repository.js';
import type { ProjectRow } from '../../common/database/schema.js';

/**
 * The application service between the controller and the repository — spec §3 steps 5 to 7.
 *
 * It exists for two reasons that the controller cannot serve and the repository must not:
 *
 * 1. **The object-level authorization decision.** `CapabilityGuard` has already asked whether
 *    this principal may exercise `project.create` in this organization *at all*. That is the
 *    coarse question, and it is all a guard can honestly answer, because the object has not
 *    been loaded yet. This is where the second `authorize()` call happens, with a
 *    `ResourceContext` built from the row — project relation, audience, lifecycle. §3 orders
 *    it exactly this way: step 4 loads the facts, step 5 evaluates them.
 *
 * 2. **The transaction boundary.** `TenantDatabase.transaction()` binds one connection to one
 *    context for a whole unit of work, and §3 step 8 requires the audit and outbox events to
 *    land in the same transaction as the state change. A controller opening that would be a
 *    controller holding a database handle, which the lint boundary forbids.
 *
 * The repository stays free of policy, the controller stays free of both.
 */

/** What a caller is allowed to see of a project. */
export interface ProjectView {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: string;
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * An explicit projection, not a serialised row.
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §7 is blunt: "Never implement client access as
 * `serializeInternalObject(); delete fields`." Listing the fields means a column added to
 * `projects` in a future migration is invisible to every caller until someone decides it
 * should not be — the safe direction. `organization_id` is deliberately absent: the caller
 * already knows which organization they asked about, and echoing a tenant identifier into a
 * response body is how one ends up in a client's bug report.
 */
function toView(row: ProjectRow): ProjectView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

export class ProjectsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * List the projects this principal may read.
   *
   * The tenant filter is the repository's and is not optional. What this adds is the
   * *relation* filter, which the repository has no business knowing about: an internal member
   * without organization-wide scope sees the projects they are a member of, and a client
   * principal sees the projects shared with their client organization. Both lists are already
   * on `Principal.projectIds`, loaded on the scoped path by `PrincipalRepository`.
   *
   * Filtering after the read rather than pushing the id list into the query is deliberate at
   * this size: `authorize()` is the single place the relation rule is written, and duplicating
   * it as a `WHERE ... IN (...)` would create a second copy free to disagree with it. When a
   * tenant's project count makes that cost real, the fix is to pass `projectIds` into the
   * repository as an explicit filter — not to relax the check.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListProjectsOptions = {},
  ): Promise<readonly ProjectView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.projects.list(runner, context, options),
    );

    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: row.organizationId,
              projectId: row.id,
              audience: 'internal',
              lifecycle: row.archivedAt ? 'archived' : 'active',
            },
          }).allowed,
      )
      .map(toView);
  }

  /**
   * Read one project.
   *
   * A project the principal has no relation to produces **not found**, not forbidden. The
   * reasoning is `ProjectsRepository`'s and applies with more force here: 403 confirms the row
   * exists, and "which projects does this agency run" is exactly the thing a client of that
   * agency must not be able to enumerate.
   */
  async get(context: TenantContext, principal: Principal, projectId: string): Promise<ProjectView> {
    const row = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
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
          lifecycle: row.archivedAt ? 'archived' : 'active',
        },
      }).allowed;

    if (!row || !permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    return toView(row);
  }

  /**
   * Create a project.
   *
   * In a transaction even though it is one insert: step 8 puts the outbox and audit events in
   * the same transaction as the state change, and neither writer exists yet (PLAT-004's relay
   * and AUD-001). Establishing the boundary now means adding them is one line inside an
   * existing `transaction()` rather than a change to the shape of the command.
   */
  async create(context: TenantContext, input: CreateProjectInput): Promise<ProjectView> {
    const row = await this.database.transaction(context, (tx) =>
      this.projects.create(tx, context, input),
    );
    return toView(row);
  }
}
