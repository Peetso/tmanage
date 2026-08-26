import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectsRepository } from './projects.repository.js';
import type { CreateProjectInput, ListProjectsOptions } from './projects.repository.js';
import type { ProjectRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';

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
  /**
   * The two dates, kept apart in the projection because they mean different things.
   *
   * `committedAt` is a promise; `forecastAt` is an estimate. Collapsing them into one
   * `dueAt` would be convenient and would lose the distinction `22-SCREEN-BY-SCREEN` §3
   * makes on `ON-03` and the design language draws on every pulse track.
   */
  readonly committedAt: string | null;
  readonly forecastAt: string | null;
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
    committedAt: row.committedAt ? row.committedAt.toISOString() : null,
    forecastAt: row.forecastAt ? row.forecastAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

export class ProjectsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * Optional so that every existing construction of this service keeps working, and so a
     * test can assert the audit row without wiring one. It is supplied by `ProjectsModule` in
     * the running application; a `create` with no audit service writes no audit row, which is
     * a fact a test can assert rather than a silence it has to trust.
     */
    private readonly audit?: AuditService,
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
   * The transaction was here before the audit writer existed — the note used to say so, and
   * to say that adding it would be "one line inside an existing `transaction()` rather than a
   * change to the shape of the command". That turned out to be exactly right, and this is the
   * line. The outbox event is still missing, because `PLAT-004`'s relay is still not written.
   *
   * The owner defaults to the acting person rather than to null. A project with no owner is
   * a project nothing can be escalated to, and the person creating one on a setup screen is
   * the obvious answer until there is a people picker to choose otherwise. No ticket in
   * `28-SPRINT-TICKETS` builds one.
   */
  async create(context: TenantContext, input: CreateProjectInput): Promise<ProjectView> {
    const withOwner: CreateProjectInput = {
      ...input,
      ownerUserId: input.ownerUserId ?? context.userId,
    };

    const row = await this.database.transaction(context, async (tx) => {
      const created = await this.projects.create(tx, context, withOwner);

      await this.audit?.record(tx, context, {
        action: 'project.created',
        objectId: created.id,
        result: 'allowed',
        metadata: {
          workspace_id: created.workspaceId,
          owner_user_id: created.ownerUserId,
          // Whether a target date was set, not the date itself. A date is a fact about the
          // work rather than an identifier, and §12's rule for metadata is identifiers and
          // classifications only.
          has_forecast_date: created.forecastAt !== null,
        },
      });

      return created;
    });

    return toView(row);
  }
}
