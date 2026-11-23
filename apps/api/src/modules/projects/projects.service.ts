import { authorize, PROJECT_CREATOR_ROLE } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import {
  ProjectNotFoundError,
  ProjectVersionConflictError,
  ProjectsRepository,
} from './projects.repository.js';
import { ProjectMembershipsRepository } from './project-memberships.repository.js';
import type { CreateProjectInput, ListProjectsOptions } from './projects.repository.js';
import type { ProjectRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { requireOrgPermission } from '../tenancy/org-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';

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
    // Already 'YYYY-MM-DD' strings: DATE columns in string mode (0012). Passed through
    // rather than serialised, so no instant exists for a reader's timezone to move.
    committedAt: row.committedAt,
    forecastAt: row.forecastAt,
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
    private readonly memberships: ProjectMembershipsRepository = new ProjectMembershipsRepository(),
    /** F47. Injected only by a unit test; the default reads the org settings table. */
    private readonly orgSettings?: OrgSettingsRepository,
  ) {}

  /**
   * F47. The creation policy, in the one place every create path passes through: the principal must
   * hold `project.create` in this organization (a custom role with `project.manage` alone may not
   * originate projects), and when the owner has turned "Members can create projects" off only the
   * admins may. Public so a caller that writes more than the project (a template's plan) can refuse
   * before its own reads; {@link create} always runs it again.
   */
  async requireMayCreate(context: TenantContext, principal: Principal): Promise<void> {
    const permitted = authorize({
      principal,
      capability: 'project.create',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'denied_project.create');
    }
    await requireOrgPermission(
      this.database,
      context,
      principal,
      'members_can_create_projects',
      this.orgSettings,
    );
  }

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
   *
   * The creator is also put on the project, as its manager, in the same transaction (PRJ-01).
   * Without that row a creator without organization-wide scope — a manager — could not read the
   * project they had just made: `Principal.projectIds` comes from `project_memberships`, and an
   * empty relation is "not found". Only roles at or above manager hold `project.create`, so the
   * grant never exceeds the creator's own ceiling.
   *
   * F47. The principal is required: `project.create` and the "Members can create projects" switch
   * are enforced here, so no entry point (POST /projects, a template instantiate) can skip them.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: CreateProjectInput,
  ): Promise<ProjectView> {
    await this.requireMayCreate(context, principal);

    const row = await this.database.transaction(context, (tx) =>
      this.createInTransaction(tx, context, input),
    );

    return toView(row);
  }

  /**
   * Fix lane C (2026-11-23, owner rule "anything the account can do by hand, the AI can do"). Rename
   * a project. `project.manage` on this project (a manager only on a project they manage, the
   * evaluator's narrowing); a project the caller cannot read is 404. Optimistic on
   * `expectedUpdatedAt` (the `updatedAt` last read): a stale value is 409 with the current one.
   */
  async rename(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    input: { readonly name: string; readonly expectedUpdatedAt: string },
  ): Promise<ProjectView> {
    const expected = new Date(input.expectedUpdatedAt);
    const row = await this.database.transaction(context, async (tx) => {
      const current = await this.requireActionable(
        tx,
        context,
        principal,
        projectId,
        'project.manage',
      );
      if (current.archivedAt !== null) {
        throw new ApiError(
          409,
          'conflict',
          'An archived project cannot be renamed. Restore it first.',
          [{ field: 'projectId', message: 'is archived' }],
        );
      }
      let updated: ProjectRow;
      try {
        updated = await this.projects.update(tx, context, projectId, expected, {
          name: input.name,
        });
      } catch (error) {
        if (error instanceof ProjectVersionConflictError) {
          throw new ApiError(409, 'conflict', MESSAGES.conflict, [
            {
              field: 'expectedUpdatedAt',
              message: `stale; current is ${current.updatedAt.toISOString()}`,
            },
          ]);
        }
        throw error;
      }
      await this.audit?.record(tx, context, {
        action: 'project.renamed',
        objectId: projectId,
        result: 'allowed',
        metadata: {},
      });
      return updated;
    });
    return toView(row);
  }

  /**
   * Fix lane C. Archive (`archived: true`) or restore (`false`) a project: out of every list and
   * back, nothing erased. `project.manage` on this project. Archiving an archived project (or
   * restoring an active one) is not an error and writes no audit row.
   */
  async setArchived(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    archived: boolean,
  ): Promise<ProjectView> {
    const row = await this.database.transaction(context, async (tx) => {
      const current = await this.requireActionable(
        tx,
        context,
        principal,
        projectId,
        'project.manage',
      );
      if ((current.archivedAt !== null) === archived) return current;
      const next = archived
        ? await this.projects.archive(tx, context, projectId)
        : await this.projects.unarchive(tx, context, projectId);
      await this.audit?.record(tx, context, {
        action: archived ? 'project.archived' : 'project.unarchived',
        objectId: projectId,
        result: 'allowed',
        metadata: {},
      });
      return next;
    });
    return toView(row);
  }

  /**
   * Fix lane C. Delete an EMPTY project (`project.delete` on this project). A project that still
   * holds anything (a work item, document, file, meeting, conversation, client link, …) is refused
   * with 409 `project_not_empty`, and nothing is written: archive it instead. The database decides
   * "empty" through its foreign keys (see `ProjectsRepository.deleteEmpty`).
   */
  async deleteEmpty(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    try {
      await this.database.transaction(context, async (tx) => {
        await this.requireActionable(tx, context, principal, projectId, 'project.delete');
        // The audit row is written first, in the same unit of work: if the delete is refused the
        // whole transaction rolls back and no row claims a deletion that did not happen.
        await this.audit?.record(tx, context, {
          action: 'project.deleted',
          objectId: projectId,
          result: 'allowed',
          metadata: {},
        });
        await this.projects.deleteEmpty(tx, context, projectId);
      });
    } catch (error) {
      if (isRowReferenced(error)) {
        throw new ApiError(
          409,
          'conflict',
          'This project still holds work, files or links, so it cannot be deleted. Archive it instead.',
          [{ field: 'projectId', message: 'project_not_empty' }],
          'project_not_empty',
        );
      }
      if (error instanceof ProjectNotFoundError) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
      }
      throw error;
    }
  }

  /**
   * Read the project inside the unit of work and decide `capability` on it. Not readable is 404
   * (as {@link get}); readable but not permitted is 403.
   */
  private async requireActionable(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Capability,
  ): Promise<ProjectRow> {
    const row = await this.projects.findById(tx, context, projectId);
    const resource = (r: ProjectRow) => ({
      organizationId: r.organizationId,
      projectId: r.id,
      audience: 'internal' as const,
      lifecycle: r.archivedAt ? ('archived' as const) : ('active' as const),
    });
    if (
      row === null ||
      !authorize({ principal, capability: 'work.read', resource: resource(row) }).allowed
    ) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
    // The lifecycle itself is what archive, restore and delete act on, so the capability is
    // decided as on an active project; rename refuses an archived one on its own.
    const verdict = authorize({
      principal,
      capability,
      resource: { ...resource(row), lifecycle: 'active' },
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
    return row;
  }

  /**
   * 52-08. The body of {@link create} inside a caller's transaction, for a command that writes more
   * than the project in one unit of work ("Convert to project" on a quote). The caller MUST have run
   * {@link requireMayCreate} first; this writes the project, the creator's manager row and both audit
   * rows exactly as {@link create} does.
   */
  async createInTransaction(
    tx: TenantQueryRunner,
    context: TenantContext,
    input: CreateProjectInput,
  ): Promise<ProjectRow> {
    const withOwner: CreateProjectInput = {
      ...input,
      ownerUserId: input.ownerUserId ?? context.userId,
    };
    const created = await this.projects.create(tx, context, withOwner);

    const creator = await this.memberships.add(tx, context, {
      projectId: created.id,
      userId: context.userId,
      role: PROJECT_CREATOR_ROLE,
    });
    await this.audit?.record(tx, context, {
      action: 'project_membership.granted',
      result: 'allowed',
      objectId: creator.id,
      metadata: {
        project_id: creator.projectId,
        target_user_id: creator.userId,
        granted_role: creator.role,
      },
    });

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
  }
}

/** MariaDB's "a row elsewhere still points at it" (ER_ROW_IS_REFERENCED_2 / ER_ROW_IS_REFERENCED). */
function isRowReferenced(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const errno = (current as { errno?: unknown }).errno;
    if (errno === 1451 || errno === 1217) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export { toView as toProjectView };
