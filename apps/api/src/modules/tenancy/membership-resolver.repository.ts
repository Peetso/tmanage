import { and, eq, gt, gte, isNull, ne, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import {
  CAPABILITIES,
  customRoleKey,
  effectiveCapabilitySet,
  isClientRole,
  isCustomRoleId,
  isInternalRole,
  isPlatformSupportRole,
  isRole,
  parseCustomRoleCapabilities,
} from '@tmanage/domain';
import type { PermissionOverrides, PrincipalRole, Role } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  customRoles,
  memberships,
  organizations,
} from '../../common/database/schema.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { AuditService } from '../audit/audit.service.js';
import { MembershipOverridesRepository, NO_OVERRIDES } from './membership-overrides.repository.js';

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
  /**
   * Validated against the capability table; never the raw `VARCHAR(64)` from the row. For an
   * internal member holding a custom role (Control > Roles) it is the custom role key built from
   * the tenant's own `custom_roles` row, carrying exactly that row's allowlisted capabilities.
   */
  readonly role: PrincipalRole;
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
  /**
   * platform-admin v2 · PA-01 (SPEC §3.3). The member's live permission overrides (not revoked,
   * not expired), loaded tenant-scoped with the membership. `principalFor` puts them on the
   * principal, where `authorize()` step 3 reads them. The resolver always sets it (empty lists when
   * there are none); optional only so hand-built test fixtures keep compiling.
   */
  readonly overrides?: PermissionOverrides;
  /**
   * platform-admin v2 · PA-01 (SPEC §3.2). Set only for the hidden `platform_support` role: the
   * live Support session the membership is bound to. A `platform_support` membership whose session
   * has ended or expired never resolves, so this is never stale on a resolved membership.
   */
  readonly supportSession?: ResolvedSupportSession | null;
}

/** PA-01. The live Support session behind a `platform_support` membership. */
export interface ResolvedSupportSession {
  readonly id: string;
  readonly adminUserId: string;
  readonly expiresAt: Date;
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
  | 'organization_suspended'
  /**
   * Wave 11 Q4 (M05). The caller holds a live client row here, but their staff membership in the
   * same company was suspended, or offboarded after that client row was created. A client row
   * from before the staff stop must not keep the person in through the portal. Raised only after
   * the client row has proved the caller belongs; mapped like every other refusal (the neutral
   * organization-not-found answer), so it tells the caller nothing about the company.
   */
  | 'staff_access_stopped'
  /**
   * platform-admin v2 · PA-01 (SPEC §6 0243). A proved member of an organization the platform
   * operator has deleted (`organizations.deleted_at`; restorable until `purge_after`). Raised only
   * after the membership row matched, like `organization_suspended`.
   */
  | 'organization_closed';

/** What a member of a suspended company is told. The data is kept; support can reopen it. */
export const SUSPENDED_MESSAGE =
  'This workspace is suspended. Contact TManage support to have it reopened.';

/** PA-01. What a member of a deleted (not yet purged) company is told. */
export const CLOSED_MESSAGE =
  'This workspace has been closed. Contact TManage support if you think this is a mistake.';

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
  /** PA-01 / 0243. Set when the platform operator deleted the company; the member is refused. */
  readonly deletedAt?: Date | null;
}

/**
 * PA-01. Whether `organizations.deleted_at` (migration 0243, PA-07, wave 2) exists yet.
 *
 * The resolver reads the column only once it is there: it asks the server once per process
 * (`SELECT deleted_at … LIMIT 0`), remembers the answer, and from then on the deleted check costs
 * nothing extra. A deploy runs the migrations before the new process starts, so the first probe
 * after 0243 sees the column. Exported for the tests only.
 */
export const ORGANIZATION_DELETED_AT = {
  state: 'unknown' as 'unknown' | 'present' | 'absent',
  reset(): void {
    this.state = 'unknown';
  },
};

/** MySQL/MariaDB "unknown column" (ER_BAD_FIELD_ERROR), however the driver wrapped it. */
function isUnknownColumn(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const candidate = current as { errno?: unknown; code?: unknown; cause?: unknown };
    if (candidate.errno === 1054 || candidate.code === 'ER_BAD_FIELD_ERROR') return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * PA-01. The live Support session behind a `platform_support` membership (SPEC §3.2: live means
 * `ended_at IS NULL AND expires_at > now`, by the server's clock). `platform_support_sessions` is a
 * global table (0240), so the read names no tenant table beyond the allowlist.
 */
const LIVE_SUPPORT_SESSION_SQL =
  'SELECT id, admin_user_id, expires_at FROM platform_support_sessions ' +
  'WHERE organization_id = ? AND membership_id = ? AND admin_user_id = ? ' +
  'AND ended_at IS NULL AND expires_at > now(3) ' +
  'ORDER BY started_at DESC LIMIT 1';

/** How many shadowed client rows one resolver remembers having audited (bounded, per process). */
const SHADOW_AUDIT_MEMORY = 1000;

export class MembershipResolver {
  /** Client rows already recorded as shadowed, so a busy staff member does not write one per request. */
  private readonly auditedShadows = new Set<string>();

  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: Pick<AuditService, 'recordStandalone'> = new AuditService(database),
    private readonly overrides: Pick<
      MembershipOverridesRepository,
      'liveOverrides'
    > = new MembershipOverridesRepository(),
  ) {}

  async resolve(request: ResolveMembershipRequest): Promise<ResolvedMembership> {
    // PA-01: learn once per process whether 0243's `organizations.deleted_at` exists. Its own
    // short read, so the resolution transaction below runs the same statements in the same order.
    if (ORGANIZATION_DELETED_AT.state === 'unknown') {
      await this.database.bootstrapRead(
        {
          correlationId: request.correlationId,
          reason: RESOLUTION_REASON,
          tables: ['organizations'],
        },
        (tx) => this.probeDeletedAt(tx),
      );
    }
    const { internal, client, staffStopped, supportSession } = await this.database.bootstrapRead(
      {
        correlationId: request.correlationId,
        reason: RESOLUTION_REASON,
        tables: [...RESOLUTION_TABLES],
      },
      async (tx) => {
        let internal = await this.internalMembership(tx, request);
        // PA-01 (SPEC §3.2): the hidden Support-session role resolves only while its session row
        // is live. An ended or expired session leaves the row unresolved — `no_active_membership`.
        let supportSession: ResolvedSupportSession | null = null;
        if (internal !== null && isPlatformSupportRole(internal.role)) {
          supportSession = await this.liveSupportSession(tx, request, internal);
          if (supportSession === null) internal = null;
        }
        const client = await this.clientMembership(tx, request);
        // Wave 11 Q4 (M05): only a client-only resolution needs the staff row's history. Active
        // staff are the F27b case above and resolve as staff, unchanged.
        const staffStopped =
          internal === null && client !== null && (await this.staffStopped(tx, request, client));
        return { internal, client, staffStopped, supportSession };
      },
    );

    // Both queries always run, even though one match is enough to proceed. The second round
    // trip buys the ambiguity check below, and a resolver that stopped at the first match
    // could not make it — it would silently prefer whichever it happened to ask for first.
    //
    // Wave 10 R5 (F27b). An active internal membership plus a live client row in the same company
    // resolves as the staff member: the internal row alone already grants exactly that, so
    // preferring it widens nothing, while refusing locked the person out of the whole tenant. The
    // client row is recorded as shadowed (below). The two rows must name the same organization —
    // anything else stays fail-closed as `principal_kind_ambiguous`.
    if (internal && client && internal.organizationId !== client.organizationId) {
      throw new MembershipNotResolvedError('principal_kind_ambiguous');
    }
    const shadowedClient = internal && client ? client : null;

    const candidate = internal ?? client;
    if (!candidate) throw new MembershipNotResolvedError('no_active_membership');
    // After the membership is proved, so only a real member learns the company is suspended.
    if (candidate.suspendedAt !== null) {
      throw new MembershipNotResolvedError('organization_suspended');
    }
    // PA-01: a deleted (restorable) company refuses its members the same way, after the proof.
    if (candidate.deletedAt != null) throw new MembershipNotResolvedError('organization_closed');
    // Wave 11 Q4 (M05). After the client row proved membership, like the check above.
    if (staffStopped) throw new MembershipNotResolvedError('staff_access_stopped');

    const kind = internal ? 'internal' : 'client';
    const contextFor = (role: PrincipalRole, overrides: PermissionOverrides = NO_OVERRIDES) =>
      createTenantContext({
        organizationId: candidate.organizationId,
        userId: request.userId,
        principalKind: kind,
        membershipId: candidate.membershipId,
        // PA-01: the context carries the effective set — role ∪ allow − deny — in
        // `CAPABILITIES` order, so every reader of `context.capabilities` sees the overrides.
        capabilities: effectiveCapabilities(role, overrides),
        policyVersion: policyVersionOf(
          candidate.organizationPolicyVersion,
          candidate.membershipPolicyVersion,
        ),
        correlationId: request.correlationId,
      });

    const role =
      kind === 'internal' && !isRole(candidate.role)
        ? await this.customRole(candidate.role, contextFor)
        : this.validateRole(candidate.role, kind);

    // PA-01: the member's live overrides, read on the ordinary scoped path bound to the
    // organization the membership row just proved (same as the custom role read above).
    const overrides = await this.database.read(contextFor(role), (runner) =>
      this.overrides.liveOverrides(runner, contextFor(role), candidate.membershipId, kind),
    );
    const context = contextFor(role, overrides);
    if (shadowedClient !== null) await this.recordShadowedClient(context, shadowedClient);

    return {
      context,
      role,
      clientOrganizationId: candidate.clientOrganizationId,
      // A live Support session is org-wide by definition (SPEC P3), whatever the row says.
      hasOrgWideScope: supportSession !== null ? true : candidate.hasOrgWideScope,
      workspaceScopeId: supportSession !== null ? null : candidate.workspaceScopeId,
      overrides,
      supportSession,
    };
  }

  /** PA-01. Learn once per process whether `organizations.deleted_at` exists (0243). */
  private async probeDeletedAt(tx: BootstrapQueryRunner): Promise<void> {
    if (ORGANIZATION_DELETED_AT.state !== 'unknown') return;
    try {
      await tx.query('SELECT deleted_at FROM organizations LIMIT 0');
      ORGANIZATION_DELETED_AT.state = 'present';
    } catch (error) {
      if (!isUnknownColumn(error)) throw error;
      ORGANIZATION_DELETED_AT.state = 'absent';
    }
  }

  /** PA-01. The live Support session for a `platform_support` membership, or null. */
  private async liveSupportSession(
    tx: BootstrapQueryRunner,
    request: ResolveMembershipRequest,
    internal: Candidate,
  ): Promise<ResolvedSupportSession | null> {
    const rows = (await tx.query(LIVE_SUPPORT_SESSION_SQL, [
      internal.organizationId,
      internal.membershipId,
      request.userId,
    ])) as unknown as readonly Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const expiresAt = row['expires_at'];
    return {
      id: String(row['id']),
      adminUserId: String(row['admin_user_id']),
      expiresAt: expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt)),
    };
  }

  /**
   * Wave 10 R5 (F27b). Leave a trace of the client row the staff resolution ignored, once per row per
   * resolver. Best effort: the person is staff either way, and a failed audit write must not turn
   * back into the tenant-wide lockout this replaces.
   */
  private async recordShadowedClient(context: TenantContext, client: Candidate): Promise<void> {
    const key = `${client.organizationId}:${client.membershipId}`;
    if (this.auditedShadows.has(key)) return;
    try {
      await this.audit.recordStandalone(context, {
        action: 'client_membership.shadowed_by_internal',
        objectId: client.membershipId,
        result: 'allowed',
        metadata: {
          client_organization_id: client.clientOrganizationId ?? 'none',
          internal_membership_id: context.membershipId,
        },
      });
      if (this.auditedShadows.size >= SHADOW_AUDIT_MEMORY) this.auditedShadows.clear();
      this.auditedShadows.add(key);
    } catch {
      // Retried on the next resolution, since the key was not remembered.
    }
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
   * An internal membership whose stored role is not a built-in name: a custom role id (F1).
   *
   * The lookup runs on the ordinary **scoped** path, bound to the organization the membership
   * row just proved, so `custom_roles` never joins the unscoped bootstrap read and a role id from
   * another tenant simply does not match — it denies as `role_not_recognised`, exactly like an id
   * nobody defined. The principal gets only the allowlisted capabilities the row stores; the
   * provisional context used for the read holds no capability at all. Client memberships never
   * reach here: a client with a non-built-in role is refused by {@link validateRole}.
   */
  private async customRole(
    stored: string,
    contextFor: (role: PrincipalRole) => TenantContext,
  ): Promise<PrincipalRole> {
    // Ids are lowercase UUIDs; a row written from an upper-case request body still names the role.
    const id = stored.toLowerCase();
    if (!isCustomRoleId(id)) throw new MembershipNotResolvedError('role_not_recognised');
    const provisional = contextFor(customRoleKey(id, []));
    const rows = await this.database.read(provisional, (runner) =>
      tenantDrizzle(runner)
        .select({ id: customRoles.id, capabilitiesJson: customRoles.capabilitiesJson })
        .from(customRoles)
        .where(
          and(eq(customRoles.organizationId, provisional.organizationId), eq(customRoles.id, id)),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row || row.id !== id) throw new MembershipNotResolvedError('role_not_recognised');
    return customRoleKey(row.id, parseCustomRoleCapabilities(row.capabilitiesJson));
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
        ...deletedAtColumn(),
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

  /**
   * Wave 11 Q4 (M05). Whether the person's staff membership in the client row's company has been
   * stopped in a way the client row predates: `suspended` (any time — a suspension is a pause, and
   * the portal must not be the way around it), or `offboarded` at or after the client row was
   * created. A client row created after offboarding is a deliberate re-invitation as a client
   * (F27a lets offboarded staff accept one) and still works.
   *
   * Bound to the organization and the client row the previous read proved, by id; reads only the
   * two membership tables the bootstrap read already names, and returns a status, nothing else.
   */
  private async staffStopped(
    tx: BootstrapQueryRunner,
    request: ResolveMembershipRequest,
    client: Candidate,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(tx)
      .select({ status: memberships.status })
      .from(memberships)
      .innerJoin(
        clientMemberships,
        and(
          eq(clientMemberships.id, client.membershipId),
          eq(clientMemberships.organizationId, memberships.organizationId),
        ),
      )
      .where(
        and(
          eq(memberships.organizationId, client.organizationId),
          eq(memberships.userId, request.userId),
          or(
            eq(memberships.status, 'suspended'),
            and(
              eq(memberships.status, 'offboarded'),
              gte(memberships.updatedAt, clientMemberships.createdAt),
            ),
          ),
        ),
      )
      // `uq_memberships_org_user`: one staff row per person per company.
      .limit(1);
    const status = rows[0]?.status;
    return status === 'suspended' || status === 'offboarded';
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
        ...deletedAtColumn(),
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

/** PA-01. `organizations.deleted_at` as a select field, only once 0243 has added it. */
function deletedAtColumn(): { deletedAt?: SQL<Date | null> } {
  if (ORGANIZATION_DELETED_AT.state !== 'present') return {};
  return { deletedAt: sql<Date | null>`${organizations}.deleted_at`.mapWith(toDateOrNull) };
}

function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

/** PA-01. The context's capability list: role ∪ allow − deny, in `CAPABILITIES` order. */
function effectiveCapabilities(
  role: PrincipalRole,
  overrides: PermissionOverrides,
): readonly (typeof CAPABILITIES)[number][] {
  const held = effectiveCapabilitySet({ role, overrides });
  return CAPABILITIES.filter((capability) => held.has(capability));
}

/** A client row still open (not offboarded) for one person in the acting tenant. */
export interface OpenClientRow {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly status: (typeof clientMemberships.$inferSelect)['status'];
  readonly updatedAt: Date;
}

/**
 * Wave 11 Q4 (M05). The client rows a person still holds in the acting tenant, for internal
 * invitation acceptance to end in the same transaction: once someone is staff here, an older
 * client row would otherwise outlive a later suspension of that staff membership.
 *
 * Tenant-scoped (`organization_id` from the context, never from input) and ordinary — unlike the
 * resolver above it runs on the caller's tenant transaction, not the bootstrap read.
 */
export class StaffClientRowsRepository {
  async openClientRowsOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<readonly OpenClientRow[]> {
    return tenantDrizzle(runner)
      .select({
        id: clientMemberships.id,
        clientOrganizationId: clientMemberships.clientOrganizationId,
        status: clientMemberships.status,
        updatedAt: clientMemberships.updatedAt,
      })
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          eq(clientMemberships.userId, userId),
          ne(clientMemberships.status, 'offboarded'),
        ),
      );
  }
}
