import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  clientOrganizations,
  memberships,
  organizations,
} from '../../common/database/schema.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * "Which organizations do I belong to?" — the read behind `ID-04`.
 *
 * This is the **second** read in this system that cannot be tenant-scoped, and it is worth
 * being explicit that adding one is a cost rather than a convenience. `MembershipResolver` is
 * the first: it answers "may this session act in *this named* organization", which is the read
 * that establishes a tenant and therefore cannot be inside one. This one answers "which
 * organizations may this session act in at all", which spans tenants by definition — a screen
 * that lists two organizations cannot be scoped to either.
 *
 * Both go through `bootstrapRead`, which is audited, read-only, and limited to a declared
 * table list. The list here is the same three tables the resolver uses plus
 * `client_organizations`, which supplies the client's own name for the portal row.
 *
 * ## Why this is not more dangerous than the resolver
 *
 * The resolver takes a slug the caller supplied and answers yes or no. This takes **no
 * caller-supplied identifier at all**: the only input is the `userId` from a verified session,
 * and the `WHERE` clause is `memberships.user_id = ?`. There is no parameter an attacker
 * could vary to widen the result, because the one parameter is who they already are.
 *
 * That property is what makes the unscoped read acceptable, and it is why this repository
 * exposes exactly one method. A second one taking any other identifier would not inherit the
 * argument.
 *
 * ## What it deliberately does not return
 *
 * No counts, no aggregates, nothing summed across organizations. `22-SCREEN-BY-SCREEN` §3 for
 * `ID-04`: "**No cross-organization aggregated content in MVP.**" A project count per row is
 * fine and belongs to that row's organization; "14 open items across your organizations" is
 * exactly the thing that sentence forbids, and this method could not produce it without a
 * second unscoped read over `work_items` — which is not in the declared table list, so the
 * guard would refuse it.
 *
 * The project count is not returned either, and that is a gap rather than a decision:
 * counting projects per organization needs `projects` in the table list, which widens the
 * unscoped read to a tenant-owned content table. `ID-04` shows a count; it is recorded as
 * open in `docs/implementation-status.md` rather than bought at that price.
 */

const DIRECTORY_REASON =
  'organization directory: the list of organizations one verified session may act in, which ' +
  'spans tenants by definition and is keyed only on the session user (ID-04)';

/** The declared table list. Membership, its organization row, and the client name. */
const DIRECTORY_TABLES = [
  'organizations',
  'memberships',
  'client_memberships',
  'client_organizations',
] as const;

export interface OrganizationMembershipSummary {
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  /** `internal` for a team membership, `client` for portal access. */
  readonly audience: 'internal' | 'client';
  readonly role: string;
  /** The client organization's own name, for a portal row. Null for an internal membership. */
  readonly clientOrganizationName: string | null;
}

export class OrganizationDirectoryRepository {
  constructor(private readonly database: TenantDatabase) {}

  /**
   * Every organization this person may act in, internal and client, in one list.
   *
   * Two statements rather than a `UNION`, for the same reason `MembershipResolver` runs two:
   * the two membership kinds have different tables, different status vocabularies and
   * different expiry rules, and a `UNION` that lined them up would have to flatten those
   * differences into a shape that hides them.
   *
   * A person may hold both an internal membership and a client membership in the same
   * organization. The resolver treats that as `principal_kind_ambiguous` and refuses, because
   * it must pick one. This method does not refuse — it returns both rows, because that *is*
   * the honest answer to "which organizations may you act in", and the refusal is the
   * resolver's job at the moment one is chosen. A person in that state sees the organization
   * twice on `ID-04` and is refused when they pick either, which is confusing and correct;
   * hiding one would be neither.
   */
  async listForUser(input: {
    userId: string;
    correlationId: string;
  }): Promise<readonly OrganizationMembershipSummary[]> {
    const { internal, client } = await this.database.bootstrapRead(
      {
        correlationId: input.correlationId,
        reason: DIRECTORY_REASON,
        tables: [...DIRECTORY_TABLES],
      },
      async (tx) => ({
        internal: await tenantDrizzle(tx)
          .select({
            organizationId: organizations.id,
            slug: organizations.slug,
            name: organizations.name,
            role: memberships.role,
          })
          .from(memberships)
          .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
          .where(
            and(
              eq(memberships.userId, input.userId),
              eq(memberships.status, 'active'),
              // An archived organization is not somewhere anyone may act. It is excluded
              // here rather than filtered by the caller, so a future second caller cannot
              // forget.
              isNull(organizations.archivedAt),
            ),
          )
          .orderBy(asc(organizations.name)),

        client: await tenantDrizzle(tx)
          .select({
            organizationId: organizations.id,
            slug: organizations.slug,
            name: organizations.name,
            role: clientMemberships.role,
            clientOrganizationName: clientOrganizations.name,
          })
          .from(clientMemberships)
          .innerJoin(organizations, eq(organizations.id, clientMemberships.organizationId))
          .innerJoin(
            clientOrganizations,
            and(
              eq(clientOrganizations.id, clientMemberships.clientOrganizationId),
              // The composite join, not just the id. ADR-0001 layer 1 puts `organization_id`
              // in every foreign key precisely so a join cannot cross tenants; dropping it
              // here because "the id is unique anyway" is how that protection is lost one
              // query at a time.
              eq(clientOrganizations.organizationId, clientMemberships.organizationId),
            ),
          )
          .where(
            and(
              eq(clientMemberships.userId, input.userId),
              eq(clientMemberships.status, 'active'),
              isNull(organizations.archivedAt),
              // Client access expires. The server's clock decides, not this process's —
              // `MembershipResolver` makes the same call for the same reason.
              or(isNull(clientMemberships.expiresAt), sql`${clientMemberships.expiresAt} > now(3)`),
            ),
          )
          .orderBy(asc(organizations.name)),
      }),
    );

    return [
      ...internal.map((row) => ({
        organizationId: row.organizationId,
        slug: row.slug,
        name: row.name,
        audience: 'internal' as const,
        role: row.role,
        clientOrganizationName: null,
      })),
      ...client.map((row) => ({
        organizationId: row.organizationId,
        slug: row.slug,
        name: row.name,
        audience: 'client' as const,
        role: row.role,
        clientOrganizationName: row.clientOrganizationName,
      })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }
}
