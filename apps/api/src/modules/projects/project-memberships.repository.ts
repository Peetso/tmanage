import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import type { InternalRole } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectMemberships, projects } from '../../common/database/schema.js';
import type { ProjectMembershipRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Project memberships — which internal people are on which project.
 *
 * Follows `ProjectsRepository`: `TenantContext` as the scoping parameter, no `organizationId`
 * on any input type, keyset pagination, not-found rather than conflict for a caller in the
 * wrong tenant.
 *
 * This is the table `PrincipalRepository` reads to decide project relation, so it is the table
 * that decides what an internal member without organization-wide scope can see at all. The
 * corresponding client-side question — which client organizations may see which projects — is
 * `project_clients`, a different table with a different shape, and the two are deliberately
 * not merged: an internal member is a *person on a project*, a client relationship is an
 * *organization shown a projection of one*.
 *
 * ## Two honest departures from the projects repository, both forced by the schema
 *
 * `project_memberships` has **no `updated_at`, no `version`, and no `status`**. It carries
 * `id`, `organization_id`, `project_id`, `user_id`, `role`, `created_at` and nothing else.
 * Rather than pretend otherwise, this repository does two things differently and says why:
 *
 * 1. **Concurrency is a compare-and-swap on `role`.** {@link changeRole} takes the role the
 *    caller believes is current and refuses if the row no longer holds it. That is a weaker
 *    token than a version column: two writers setting the *same* new role both succeed, which
 *    is harmless, but two writers setting *different* roles cannot both silently win — the
 *    loser gets {@link ProjectMembershipConflictError} rather than having its intent
 *    disappear. It is the strongest token the table actually offers, and the right fix if
 *    that is not enough is a migration adding a version column, not a repository that claims
 *    a guarantee it cannot make.
 *
 * 2. **Removal is a real `DELETE`.** Everywhere else in this codebase removal is a state, not
 *    an erasure, because audit events and client-visible history reference the row. A project
 *    membership is different in kind: it is a **grant**, not a record of something that
 *    happened. Nothing references it, and a soft-deleted grant is one forgotten
 *    `WHERE deleted_at IS NULL` away from being a live grant again — the worst direction for
 *    this particular row to fail in.
 *
 *    That trade only holds if the *revocation* is recorded somewhere else, and today it is
 *    not: AUD-001 has no service and nothing writes an audit event. This is recorded as a
 *    named gap in `docs/implementation-status.md` rather than left as an implication.
 */

export class ProjectMembershipNotFoundError extends Error {
  constructor(readonly projectMembershipId: string) {
    // No organization id and no project id in the message. A caller probing for another
    // tenant's membership should learn nothing from the difference between "does not exist"
    // and "exists elsewhere" (spec §4).
    super(`Project membership ${projectMembershipId} was not found`);
    this.name = 'ProjectMembershipNotFoundError';
  }
}

export class ProjectMembershipConflictError extends Error {
  constructor(
    readonly projectMembershipId: string,
    readonly expectedRole: string,
    readonly actualRole: string,
  ) {
    super(
      `Project membership ${projectMembershipId} was modified concurrently ` +
        `(expected role ${expectedRole}, found ${actualRole})`,
    );
    this.name = 'ProjectMembershipConflictError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field
 * for a request body to populate and no code path that could prefer one over the other.
 */
export interface AddProjectMemberInput {
  readonly projectId: string;
  readonly userId: string;
  readonly role: InternalRole;
}

export interface ListProjectMembershipsOptions {
  /** Keyset pagination. Cursors are ids, and the sort is by id. */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export class ProjectMembershipsRepository {
  /**
   * CQ-12 (COL-01): every user on a project, unpaged. A project team is small; the channel a new
   * room is made for is joined by all of them at once.
   */
  async listUserIdsByProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: projectMemberships.userId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .orderBy(asc(projectMemberships.id));
    return rows.map((row) => row.userId);
  }

  /** Everyone on one project, within the acting tenant. */
  async listByProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    options: ListProjectMembershipsOptions = {},
  ): Promise<readonly ProjectMembershipRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [
      eq(projectMemberships.organizationId, context.organizationId),
      eq(projectMemberships.projectId, projectId),
    ];
    if (options.after) predicates.push(gt(projectMemberships.id, options.after));

    return tenantDrizzle(runner)
      .select()
      .from(projectMemberships)
      .where(and(...predicates))
      .orderBy(asc(projectMemberships.id))
      .limit(limit);
  }

  /**
   * Every project one person is on, within the acting tenant.
   *
   * `ix_project_memberships_user` is `(organization_id, user_id)`, so this walk is indexed in
   * the shape `07-DATA-MODEL` §9 requires — every composite index begins with
   * `organization_id`, because every legitimate query does too.
   *
   * The archived-project filter is a join rather than a second query, and the join is anchored
   * on `organization_id` on **both** sides. Binding only the membership side would still
   * return the right rows today and would be a latent cross-tenant join the moment a project
   * id were reused — the isolation corpus has a case for exactly this.
   */
  async listByUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
    options: ListProjectMembershipsOptions = {},
  ): Promise<readonly ProjectMembershipRow[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const predicates = [
      eq(projectMemberships.organizationId, context.organizationId),
      eq(projectMemberships.userId, userId),
    ];
    if (options.after) predicates.push(gt(projectMemberships.id, options.after));

    const rows = await tenantDrizzle(runner)
      .select({ membership: projectMemberships })
      .from(projectMemberships)
      .innerJoin(
        projects,
        and(
          eq(projects.id, projectMemberships.projectId),
          eq(projects.organizationId, projectMemberships.organizationId),
          eq(projects.organizationId, context.organizationId),
        ),
      )
      .where(and(...predicates))
      .orderBy(asc(projectMemberships.id))
      .limit(limit);

    return rows.map((row) => row.membership);
  }

  /**
   * How many projects a person is a member of, within the acting tenant.
   *
   * The access half of the offboarding impact preview (ADM-12, x121): a member's project
   * memberships are the projects they can reach, so the count is what "how much access does
   * offboarding revoke" reports before the decision. Read-only, and counted in SQL rather than
   * by paging {@link listByUser} — a preview must be exact even for someone on more projects
   * than one page holds, and it never needs the rows themselves. `ix_project_memberships_user`
   * is `(organization_id, user_id)`, the shape this predicate is, so the count is indexed.
   */
  async countByUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ memberships: sql<number>`count(*)` })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.userId, userId),
        ),
      );
    return Number(rows[0]?.memberships ?? 0);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectMembershipId: string,
  ): Promise<ProjectMembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.id, projectMembershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectMembershipId: string,
  ): Promise<ProjectMembershipRow> {
    const found = await this.findById(runner, context, projectMembershipId);
    if (!found) throw new ProjectMembershipNotFoundError(projectMembershipId);
    return found;
  }

  /**
   * One person's membership of one project.
   *
   * Scoped by `(organization_id, project_id, user_id)`, which is a unique key — the same key
   * that makes {@link add} a duplicate-key error rather than a second row.
   */
  async findByProjectAndUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    userId: string,
  ): Promise<ProjectMembershipRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.projectId, projectId),
          eq(projectMemberships.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Put someone on a project.
   *
   * The project is *not* checked to belong to the tenant here. That is not an oversight:
   * `fk_project_memberships_project_tenant` is a composite foreign key including
   * `organization_id`, so the database refuses a project from another organization. A
   * service-layer check would duplicate a guarantee that already cannot be bypassed, and would
   * drift from it.
   *
   * There is no `invited` state, unlike an internal organization membership: being added to a
   * project is not a threshold someone crosses into the tenant, it is a grant inside a tenant
   * they are already in. The threshold is `memberships`, and the resolver checks that one.
   */
  async add(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddProjectMemberInput,
  ): Promise<ProjectMembershipRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(projectMemberships)
      .values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        createdAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries a server-generated timestamp, and
    // returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /**
   * Change a project role, refusing a write that raced another.
   *
   * `expectedRole` is the concurrency token — see the note at the top of this file for why it
   * is a role rather than a version, and what that does and does not buy.
   */
  async changeRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectMembershipId: string,
    expectedRole: InternalRole,
    role: InternalRole,
  ): Promise<ProjectMembershipRow> {
    const result = await tenantDrizzle(runner)
      .update(projectMemberships)
      .set({ role })
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.id, projectMembershipId),
          eq(projectMemberships.role, expectedRole),
        ),
      );

    if (result[0].affectedRows === 0) {
      // Zero rows means one of three things: wrong tenant, no such membership, or a stale
      // token. They are distinguished by a scoped read, so a caller in the wrong tenant still
      // gets "not found" rather than a conflict that confirms the row exists.
      const current = await this.findById(runner, context, projectMembershipId);
      if (!current) throw new ProjectMembershipNotFoundError(projectMembershipId);
      // A no-op write — the row already holds the requested role — reports zero affected rows
      // on MySQL even though the predicate matched. That is success, not a conflict.
      if (current.role === role) return current;
      throw new ProjectMembershipConflictError(projectMembershipId, expectedRole, current.role);
    }

    return this.requireById(runner, context, projectMembershipId);
  }

  /**
   * Take someone off a project.
   *
   * A real delete — see the note at the top of this file for why this row, and only this row,
   * is treated as a grant rather than as history.
   *
   * Idempotent: removing an absent membership is not an error, because the caller's intent
   * ("this person is not on this project") is already satisfied and raising here would make a
   * retried request fail after the first one succeeded. Returns whether a row was actually
   * removed, so a command that needs to write an audit event knows whether anything happened.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectMembershipId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.id, projectMembershipId),
        ),
      );

    return result[0].affectedRows > 0;
  }

  /**
   * Take one person off every project in the acting tenant, in a single statement.
   *
   * The access half of offboarding (ADM-07, CQ-05): a member's project memberships *are* the
   * projects they can reach, so revoking access means these rows go. Everywhere else removal is a
   * state, but a project membership is a grant — see the note at the top of this file — so, like
   * {@link remove}, this is a real `DELETE`. One `WHERE (organization_id, user_id)` matches
   * `ix_project_memberships_user`, so it is a single indexed write rather than a row-at-a-time
   * loop, and it is run inside the offboarding transaction so access and work settle together.
   *
   * Returns how many rows were removed, so the offboard audit records the size of the revocation.
   * Zero is not an error: a member on no project is already fully revoked here.
   */
  async removeAllForUser(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.userId, userId),
        ),
      );

    return result[0].affectedRows;
  }
}
