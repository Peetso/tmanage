import { and, asc, eq } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectMemberships, users } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The client-visible people projection — SEC, module 13 portal, x142.
 *
 * `22-SCREEN-BY-SCREEN` §1 names **People** as a client-portal destination: "who you are working
 * with" at the agency. `12-PERMISSION-MATRIX` §4 excludes staff from the client projection, and
 * the only client-safe read of the internal team is a **curated name-and-role list** — the
 * "approved contacts" §4 permits. This file is that read, and nothing more.
 *
 * ## The projection is the query, not a filtered row
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §7 forbids "`serializeInternalObject(); delete fields`". So the
 * two columns a client may see — the person's display name and their role on the project — are
 * the two columns the `SELECT` names, and nothing else is ever fetched. `users.email`,
 * `users.id`, `project_memberships.id`, `project_memberships.user_id` and every column added to
 * either table later are absent because the statement never asks for them: a client cannot be
 * shown a field this process never held.
 *
 * ## Why joining `users` is legitimate (the pattern `MembershipsRepository.listWithNames` set)
 *
 * `users` carries no `organization_id` and is absent from the guard's `TENANT_TABLES` — it is
 * global identity, not tenant data. Only the `project_memberships` side has a tenant key, and it
 * is anchored to the active context with a bound `organization_id = ?` **and** the requested
 * `project_id = ?`. The rows a caller can reach are therefore the memberships of one project in
 * their own organization and the user records those rows name — never another tenant's roster:
 * an adjacent tenant's member is unreachable because their membership row is filtered out before
 * the join has anything to attach to.
 *
 * The caller resolves the project tenant-scoped and relation-checks it **before** calling here
 * (see {@link PortalPeopleController}); by the time this runs the project is known to be this
 * client's, so every member of it is a person this client is entitled to a name-and-role card
 * for. There is no per-row relation check as there is for work items, because the unit of
 * authorization is the project, not the person.
 */

/**
 * A member of a project as a client is shown them — name and role, nothing else.
 *
 * What is absent is the substance of the slice. There is no `email`, no `userId`, no membership
 * id and no "last seen": each is either staff PII or an internal identifier, and §4 gives the
 * client "approved contacts", not the agency's address book. Listing the two fields means a
 * column added to `users` or `project_memberships` tomorrow is invisible to a client until
 * someone decides otherwise.
 */
export interface PortalPersonView {
  readonly displayName: string;
  /** The person's role on this project (`member`, `lead`, …). A label, not an identifier. */
  readonly role: string;
}

/** A project's team can be shown in full; a client directory with paging is deferred to NS-13. */
const MAX_PEOPLE = 200;

export class PortalPeopleProjection {
  /**
   * The client-visible team of one project, within the acting tenant.
   *
   * Both `organization_id` and `project_id` predicates are on the tenant-keyed side. The select
   * list is the projection: only `display_name` and `role` leave the database. Ordered by name
   * (then membership id, a stable tiebreak) so the list a client reads is deterministic.
   */
  async listForProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<readonly PortalPersonView[]> {
    return tenantDrizzle(runner)
      .select({ displayName: users.displayName, role: projectMemberships.role })
      .from(projectMemberships)
      .innerJoin(users, eq(users.id, projectMemberships.userId))
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.projectId, projectId),
        ),
      )
      .orderBy(asc(users.displayName), asc(projectMemberships.id))
      .limit(MAX_PEOPLE);
  }
}
