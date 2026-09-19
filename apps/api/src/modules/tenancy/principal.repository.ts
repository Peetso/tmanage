import { and, asc, eq } from 'drizzle-orm';
import type { Principal } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { projectClients, projectMemberships, projects } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ResolvedMembership } from './membership-resolver.repository.js';

/**
 * TEN-002 — the wiring between a resolved membership and the authorization evaluator.
 *
 * `packages/domain`'s `authorize()` is a pure function over a `Principal`. This is the only
 * place a `Principal` is assembled, and it exists so that the evaluator can stay pure: every
 * fact it reasons about is loaded here, tenant-scoped, before the decision is made. Spec
 * section 3 step 4 asks for exactly that ordering — "load minimal policy facts using a query
 * that includes the verified `organization_id`" — and step 5 evaluates afterwards.
 *
 * ## Why this runs on the *scoped* path
 *
 * The membership resolver has to waive the tenant predicate, because it is what establishes
 * the tenant. Nothing after it does. By the time this file runs there is a verified
 * `TenantContext`, so the project-relation reads are ordinary guarded queries and ADR-0001
 * layer 3 is back on the path. Keeping the split at exactly this line is what makes the
 * escape hatch one read rather than a mode the request stays in.
 */

/**
 * Which roles carry organization-wide scope by default when a membership row is written.
 *
 * `12-PERMISSION-MATRIX.md` §2 records "View internal project: Scope" for Owner, Org Admin
 * **and Workspace Admin**. Only the first two are here, and the omission is deliberate: a
 * Workspace Admin's scope is one workspace, and org-wide default scope is exactly what they
 * must not get — granting the whole organization by role name is the leak this list avoids.
 * Since 0023 a Workspace Admin's one-workspace reach is expressed by `memberships.
 * workspace_scope_id` (surfaced as `ResolvedMembership.workspaceScopeId` and read by
 * {@link PrincipalRepository.projectScope}), not by this boolean — so the default here stays
 * false and the workspace scope is a recorded per-membership decision, never a role default.
 *
 * It is a default, not a rule — {@link MembershipsRepository} takes an explicit override — so
 * an organization that wants an org-wide workspace admin can have one as a recorded decision
 * rather than as a silent consequence of a role name.
 */
export const ORG_WIDE_DEFAULT_ROLES: readonly string[] = ['owner', 'org_admin'];

export function defaultOrgWideScope(role: string): boolean {
  return ORG_WIDE_DEFAULT_ROLES.includes(role);
}

export class PrincipalRepository {
  /**
   * The projects this principal has a relation to.
   *
   * Internal and external principals reach projects by different routes, and conflating them
   * is how a client ends up with an internal project in scope: an internal member's relation
   * is a `project_memberships` row for *them*, an external member's is a `project_clients`
   * row for their *client organization*. Two tables, two meanings, no shared path.
   */
  async projectScope(
    runner: TenantQueryRunner,
    context: TenantContext,
    resolved: ResolvedMembership,
  ): Promise<readonly string[]> {
    // An organization-wide internal principal derives scope from the organization, and the
    // evaluator never consults `projectIds` for them. Loading a list to ignore it would be a
    // query per request on the largest table in the join graph.
    if (context.principalKind === 'internal' && resolved.hasOrgWideScope) return [];

    const db = tenantDrizzle(runner);

    if (context.principalKind === 'client') {
      const clientOrganizationId = resolved.clientOrganizationId;
      // Defence in depth against a resolver change: a client principal with no client
      // organization has no route to any project, and an unfiltered read of
      // `project_clients` would hand them every project shared with every client of this
      // tenant — the one boundary `04-SECURITY-PRIVACY` §5 is most emphatic about.
      if (clientOrganizationId === null) return [];

      const rows = await db
        .select({ projectId: projectClients.projectId })
        .from(projectClients)
        .where(
          and(
            eq(projectClients.organizationId, context.organizationId),
            eq(projectClients.clientOrganizationId, clientOrganizationId),
          ),
        )
        .orderBy(asc(projectClients.projectId));
      return rows.map((row) => row.projectId);
    }

    // A Workspace Admin (0023): scope is one workspace, so their reach is every project in it
    // and nothing outside it. This runs only for an internal principal that is not org-wide and
    // carries a `workspaceScopeId`; the read is anchored on `organization_id = ?`, so the
    // widening it grants can never cross the tenant. Null falls through to the narrower
    // project-membership scope below — no role name silently widens anyone.
    if (resolved.workspaceScopeId !== null) {
      const workspaceRows = await db
        .select({ projectId: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, context.organizationId),
            eq(projects.workspaceId, resolved.workspaceScopeId),
          ),
        )
        .orderBy(asc(projects.id));
      return workspaceRows.map((row) => row.projectId);
    }

    const rows = await db
      .select({ projectId: projectMemberships.projectId })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.organizationId, context.organizationId),
          eq(projectMemberships.userId, context.userId),
        ),
      )
      .orderBy(asc(projectMemberships.projectId));
    return rows.map((row) => row.projectId);
  }

  /** Load the relation set and assemble the evaluator's principal in one call. */
  async load(runner: TenantQueryRunner, resolved: ResolvedMembership): Promise<Principal> {
    const projectIds = await this.projectScope(runner, resolved.context, resolved);
    return principalFor(resolved, projectIds);
  }
}

/**
 * Assemble the evaluator's principal from facts that are already verified.
 *
 * Pure, so the mapping can be read in one place and tested without a server.
 *
 * `membershipStatus` is `'active'` unconditionally, and that is a statement about the
 * resolver rather than an assumption about the row: a membership that is invited, suspended,
 * offboarded or expired never produces a `ResolvedMembership` at all. The evaluator's own
 * first check remains in place regardless — two independent places that refuse an inactive
 * principal, which is the intent, not duplication.
 */
export function principalFor(
  resolved: ResolvedMembership,
  projectIds: readonly string[],
): Principal {
  return {
    userId: resolved.context.userId,
    organizationId: resolved.context.organizationId,
    kind: resolved.context.principalKind,
    role: resolved.role,
    membershipId: resolved.context.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: resolved.clientOrganizationId,
    projectIds,
    hasOrgWideScope: resolved.hasOrgWideScope,
  };
}
