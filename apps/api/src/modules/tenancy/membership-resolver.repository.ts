import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { capabilitiesFor, isClientRole, isInternalRole, isRole } from '@tmanage/domain';
import type { Role } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { clientMemberships, memberships, organizations } from '../../common/database/schema.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantDatabase,
} from '../../common/database/tenant-context.js';

/**
 * The membership resolver — spec section 3 steps 2 and 3.
 *
 * Every other read in this application answers a question *within* a tenant. This one
 * answers which tenant, and it is the only query in the system that legitimately cannot
 * carry an `organization_id` predicate bound to the active context: there is no active
 * context yet, and binding the predicate to the organization the *request* named would check
 * the request against itself.
 *
 * Spec section 2 draws the line this file sits on:
 *
 *   "The organization slug/ID from the route is accepted only after the API confirms an
 *    active internal or client membership."
 *
 * So the route's slug is treated as a *claim*, never as a fact. What comes out is bound to
 * the organization the membership row proves, and if no such row exists nothing comes out at
 * all. Every tenant predicate in every repository downstream inherits this decision — get it
 * wrong and the rest of the access layer scopes correctly to the wrong tenant.
 *
 * ## Why the file is named `.repository.ts`
 *
 * The lint boundary (ADR-0001 layer 4) permits a driver handle and SQL only in database and
 * repository modules. This holds queries, so it carries the suffix that says so rather than
 * an exemption added to `eslint.config.js`. It is not a tenant-scoped repository and does not
 * pretend to be one — its single method returns the context the scoped repositories require.
 *
 * ## Deliberately not here
 *
 * **Session authentication.** The caller arrives with a verified principal; validating the
 * session cookie, its revocation and its cutoff is spec section 3 step 1 and ticket ID-001,
 * which is not written. Splitting them keeps this file's contract exact: given a user that
 * authentication has already established, which organization may they act in.
 *
 * **Organization provisioning.** Creating an organization is an unscoped *write*, and the
 * bootstrap path is read-only by construction. Signup therefore needs its own reviewed entry
 * point rather than a widening of this one.
 */

/** How the route named the organization. A slug from a URL, or an id from a job payload. */
export type OrganizationReference = { readonly slug: string } | { readonly organizationId: string };

export interface ResolveMembershipRequest {
  /** Established by authentication, never read from a header, body, or query string. */
  readonly userId: string;
  /** The claim under test. Nothing downstream sees it unless a membership proves it. */
  readonly organization: OrganizationReference;
  readonly correlationId: string;
}

export interface ResolvedMembership {
  readonly context: TenantContext;
  /** Validated against the capability table; never the raw `VARCHAR(64)` from the row. */
  readonly role: Role;
  /** The client organization an external principal belongs to. Null for internal principals. */
  readonly clientOrganizationId: string | null;
  /** Whether scope comes from the organization rather than from an explicit project list. */
  readonly hasOrgWideScope: boolean;
  /**
   * A Workspace Admin's one-workspace scope (0023), or null. Consulted by
   * `PrincipalRepository.projectScope` only for an internal principal that is not org-wide: a
   * non-null id widens their reach to every project in that workspace, and null leaves the
   * project-membership fallback untouched.
   */
  readonly workspaceScopeId: string | null;
}

/**
 * Why a resolution failed. Recorded for audit; **never** returned to the caller.
 *
 * Spec section 12 requires denied sensitive attempts to be security events with safe
 * metadata, and this is that metadata. The distinction between "no such organization" and
 * "you are not a member of it" belongs in the audit trail and nowhere else — see
 * {@link MembershipNotResolvedError}.
 */
export type MembershipResolutionFailure =
  | 'no_active_membership'
  | 'role_not_recognised'
  | 'role_not_valid_for_principal_kind'
  | 'principal_kind_ambiguous'
  /**
   * 0206. A real member of a company the platform operator has suspended. Unlike the codes
   * above this one IS shown to the caller (as {@link SUSPENDED_MESSAGE}): it is raised only
   * after the membership row has proved the caller belongs, so it discloses nothing to an
   * outsider — an outsider still gets `no_active_membership`.
   */
  | 'organization_suspended';

/** What a member of a suspended company is told. The data is kept; support can reopen it. */
export const SUSPENDED_MESSAGE =
  'This workspace is suspended. Contact TManage support to have it reopened.';

/**
 * One message for every failure, and the reason it must stay that way.
 *
 * An outsider who can tell "that organization does not exist" from "that organization exists
 * but you are not in it" can enumerate the customer base one slug at a time, and slugs are
 * guessable — they are company names. The same reasoning that makes `ProjectsRepository`
 * return not-found rather than conflict to a wrong-tenant caller applies here with a larger
 * blast radius, because this failure is reachable by anyone with any valid session.
 *
 * The specific cause travels in {@link MembershipNotResolvedError.code} for the audit event.
 */
const REFUSAL_MESSAGE = 'No active membership authorises access to the requested organization';

export class MembershipNotResolvedError extends Error {
  constructor(readonly code: MembershipResolutionFailure) {
    super(REFUSAL_MESSAGE);
    this.name = 'MembershipNotResolvedError';
  }
}

/**
 * The audited reason recorded against every statement this file issues.
 *
 * Names the invariant rather than the caller, so the security event explains why the escape
 * is correct to someone reading the log a year from now.
 */
const RESOLUTION_REASON =
  'membership resolution: the read that establishes which tenant a verified session may act ' +
  'in, and therefore the one read that cannot itself be tenant-scoped (spec §3 step 2)';

/**
 * The tables the bootstrap read may touch — the union of what the two statements below need.
 *
 * Nothing tenant-owned beyond membership and its organization row. A resolver that could
 * also read `projects` or `work_items` without a tenant predicate would be a more dangerous
 * primitive than anything it exists to bootstrap.
 */
const RESOLUTION_TABLES = ['organizations', 'memberships', 'client_memberships'] as const;

/**
 * The cache and decision epoch carried on the context (spec section 9).
 *
 * Stored now, not derived from `updated_at` (0023). Both inputs still matter for the reason
 * section 11 gives — "changed role after session" is a case a stale cache key gets wrong — but
 * the inputs are the two `policy_version` columns rather than the two `updated_at` instants.
 * That is the whole point of the migration: `updated_at` carries `ON UPDATE
 * CURRENT_TIMESTAMP(3)`, so a rename rotated every member's key for a change that touched no
 * policy. `policy_version` moves only when a policy-relevant fact does, so the epoch is stable
 * across unrelated churn and rotates exactly when authority changes.
 *
 * The `v2:` prefix marks the format change from the derived-timestamp `v1:` and keeps the two
 * uncollidable, so a context minted just before a deploy never matches one minted just after.
 */
export function policyVersionOf(
  organizationPolicyVersion: number,
  membershipPolicyVersion: number,
): string {
  return `v2:${organizationPolicyVersion}:${membershipPolicyVersion}`;
}

interface Candidate {
  readonly organizationId: string;
  readonly organizationPolicyVersion: number;
  readonly membershipId: string;
  readonly role: string;
  readonly membershipPolicyVersion: number;
  readonly clientOrganizationId: string | null;
  readonly hasOrgWideScope: boolean;
  /** A Workspace Admin's one-workspace scope, or null for org-wide and project-scoped members. */
  readonly workspaceScopeId: string | null;
  /** 0206. Set when the platform operator suspended the company; the member is refused. */
  readonly suspendedAt: Date | null;
}

export class MembershipResolver {
  constructor(private readonly database: TenantDatabase) {}

  async resolve(request: ResolveMembershipRequest): Promise<ResolvedMembership> {
    const { internal, client } = await this.database.bootstrapRead(
      {
        correlationId: request.correlationId,
        reason: RESOLUTION_REASON,
        tables: [...RESOLUTION_TABLES],
      },
      async (tx) => ({
        internal: await this.internalMembership(tx, request),
        client: await this.clientMembership(tx, request),
      }),
    );

    // Both queries always run, even though one match is enough to proceed. The second round
    // trip buys the ambiguity check below, and a resolver that stopped at the first match
    // could not make it — it would silently prefer whichever it happened to ask for first.
    if (internal && client) throw new MembershipNotResolvedError('principal_kind_ambiguous');

    const candidate = internal ?? client;
    if (!candidate) throw new MembershipNotResolvedError('no_active_membership');
    // After the membership is proved, so only a real member learns the company is suspended.
    if (candidate.suspendedAt !== null) {
      throw new MembershipNotResolvedError('organization_suspended');
    }

    const kind = internal ? 'internal' : 'client';
    const role = this.validateRole(candidate.role, kind);

    return {
      context: createTenantContext({
        organizationId: candidate.organizationId,
        userId: request.userId,
        principalKind: kind,
        membershipId: candidate.membershipId,
        capabilities: capabilitiesFor(role),
        policyVersion: policyVersionOf(
          candidate.organizationPolicyVersion,
          candidate.membershipPolicyVersion,
        ),
        correlationId: request.correlationId,
      }),
      role,
      clientOrganizationId: candidate.clientOrganizationId,
      hasOrgWideScope: candidate.hasOrgWideScope,
      workspaceScopeId: candidate.workspaceScopeId,
    };
  }

  /**
   * The stored role is a `VARCHAR(64)`; the schema cannot express "one of eleven names".
   *
   * Two failures are possible and they are different. A role nobody has defined must deny
   * rather than fall through to an empty capability set — an empty set is indistinguishable
   * from a principal legitimately holding no capabilities, and would be read as one. A role
   * defined for the *other* kind of principal is the more serious case: a single wrong row in
   * `client_memberships` would otherwise hand an external principal an internal ceiling, and
   * that is exactly the widening spec section 4 forbids.
   */
  private validateRole(value: string, kind: 'internal' | 'client'): Role {
    if (!isRole(value)) throw new MembershipNotResolvedError('role_not_recognised');
    const valid = kind === 'internal' ? isInternalRole(value) : isClientRole(value);
    if (!valid) throw new MembershipNotResolvedError('role_not_valid_for_principal_kind');
    return value;
  }

  /**
   * The organization half of the predicate.
   *
   * An exact equality on a unique key in both forms. Neither a prefix nor a pattern match
   * would be safe here: `northstar-studio` and `northstar-studios` are two different
   * customers, and the seed world contains that pair precisely so a loose comparison fails
   * a test rather than a customer.
   */
  private organizationPredicate(reference: OrganizationReference) {
    return 'slug' in reference
      ? eq(organizations.slug, reference.slug)
      : eq(organizations.id, reference.organizationId);
  }

  private async internalMembership(
    tx: BootstrapQueryRunner,
    request: ResolveMembershipRequest,
  ): Promise<Candidate | null> {
    const rows = await tenantDrizzle(tx)
      .select({
        organizationId: organizations.id,
        organizationPolicyVersion: organizations.policyVersion,
        membershipId: memberships.id,
        role: memberships.role,
        membershipPolicyVersion: memberships.policyVersion,
        hasOrgWideScope: memberships.hasOrgWideScope,
        workspaceScopeId: memberships.workspaceScopeId,
        suspendedAt: organizations.suspendedAt,
      })
      .from(organizations)
      .innerJoin(memberships, eq(memberships.organizationId, organizations.id))
      .where(
        and(
          this.organizationPredicate(request.organization),
          eq(memberships.userId, request.userId),
          // Only `active`. `invited` has not accepted, `suspended` has been stopped, and
          // `offboarded` has left — none of them authorises anything, and the offboarding
          // state machine records that removal never auto-restores access.
          eq(memberships.status, 'active'),
          // An archived organization authorises nobody, including its own owner.
          isNull(organizations.archivedAt),
        ),
      )
      // At most one row can match: `uq_organizations_slug` and `uq_memberships_org_user`.
      .limit(1);

    const row = rows[0];
    return row ? { ...row, clientOrganizationId: null } : null;
  }

  private async clientMembership(
    tx: BootstrapQueryRunner,
    request: ResolveMembershipRequest,
  ): Promise<Candidate | null> {
    const rows = await tenantDrizzle(tx)
      .select({
        organizationId: organizations.id,
        organizationPolicyVersion: organizations.policyVersion,
        membershipId: clientMemberships.id,
        role: clientMemberships.role,
        membershipUpdatedAt: clientMemberships.updatedAt,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        suspendedAt: organizations.suspendedAt,
      })
      .from(organizations)
      .innerJoin(clientMemberships, eq(clientMemberships.organizationId, organizations.id))
      .where(
        and(
          this.organizationPredicate(request.organization),
          eq(clientMemberships.userId, request.userId),
          eq(clientMemberships.status, 'active'),
          // Client access is time-bounded by default. Expiry is evaluated by the server's
          // clock rather than the application's: the row is the record of authority, and two
          // API instances with skewed clocks must not disagree about whether it still holds.
          or(isNull(clientMemberships.expiresAt), gt(clientMemberships.expiresAt, sql`now(3)`)),
          isNull(organizations.archivedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    // An external principal never has organization-wide scope; their reach is the projects
    // shared with their client organization, and nothing widens that — nor a workspace scope,
    // which is an internal Workspace Admin's grant.
    //
    // `client_memberships` carries no `policy_version` column: it was left out of 0023, whose
    // acceptance is the internal path, and adding it would pull in the client-membership write
    // paths that bump it. So the client's membership epoch keeps its pre-0023 derivation from
    // `updated_at` — client role/status/expiry changes still rotate the key as before. The
    // organization half is the stored `policy_version` either way, so an organization rename no
    // longer rotates a client's key. Recorded as a divergence; a stored client policy version
    // is deferred with the multi-workspace admin work.
    const { membershipUpdatedAt, ...rest } = row;
    return {
      ...rest,
      membershipPolicyVersion: membershipUpdatedAt.getTime(),
      hasOrgWideScope: false,
      workspaceScopeId: null,
    };
  }
}
