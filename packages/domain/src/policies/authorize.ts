import {
  CLIENT_GROUP_CHAT_CAPABILITIES,
  CLIENT_GROUP_READ_ONLY_ROLE,
  capabilitySetFor,
  customRoleIdOf,
  isPlatformSupportRole,
  isClientRole,
  isInternalOnlyCapability,
  type Capability,
  type PrincipalKind,
  type PrincipalRole,
} from './capabilities.js';
import { isClientReadableAudience, type Audience } from './audience.js';

/**
 * The application-layer authorization evaluator.
 *
 * This implements the policy sequence in `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §3 as a single
 * pure function, so that the decision can be unit-tested exhaustively across the grid in
 * §12 without a database, and so that there is exactly one place where "may this principal
 * do this?" is answered.
 *
 * ## Where this sits in the defence stack
 *
 * 1. Route guards — **UX only**, never a control (`25-AUTH-AND-TENANT-ISOLATION` §3).
 * 2. **This evaluator** — the authoritative application decision.
 * 3. Scoped repositories — tenant predicate derived from `TenantContext`, never from a DTO.
 * 4. The tenant query guard — rejects any statement touching a tenant-owned table without
 *    an `organization_id` predicate (ADR-0001 layer 3).
 * 5. Composite `(organization_id, id)` foreign keys — make a cross-tenant row reference
 *    structurally impossible at the storage layer.
 *
 * The database engine is MySQL, which has **no row-level security**
 * (`04-SECURITY-PRIVACY` §4: "no control may assume it exists"). Layers 3–5 are what
 * replace it, and none of them knows about project relation, audience, reviewer
 * authority, or object state — those live here, and only here. Conversely this evaluator
 * cannot save a query that simply forgot its tenant predicate, which is why layers 4 and 5
 * exist. Neither half is sufficient alone.
 *
 * ## Deny by default
 *
 * Every path through `authorize()` either returns an explicit allow with a reason, or
 * denies. There is no fall-through that reaches the end of the function and returns
 * allow — the final statement is a deny.
 */

/** A verified principal. Never constructed from request input; always from a server session. */
export interface Principal {
  readonly userId: string;
  /**
   * Resolved from the authenticated membership, **not** from the URL or a header
   * (`04-SECURITY-PRIVACY` §4). By the time a Principal exists, this has been confirmed.
   */
  readonly organizationId: string;
  readonly kind: PrincipalKind;
  /**
   * A built-in role, or a custom role key built by the membership resolver from the tenant's
   * own `custom_roles` row (`customRoleKey`). The ceiling check below honours either: a custom
   * role holds exactly the allowlisted capabilities its row grants, and nothing else.
   */
  readonly role: PrincipalRole;
  readonly membershipId: string;
  /** Active membership is required for every action. Suspension denies immediately. */
  readonly membershipStatus: 'active' | 'suspended' | 'expired';
  /**
   * For client principals: which client organization they belong to. Null for internal.
   * Two client principals in the same tenant must never see each other's objects.
   */
  readonly clientOrganizationId: string | null;
  /**
   * Projects the principal is a member of (internal) or whose client projection they may
   * reach (client). Empty for org-wide roles that derive scope differently.
   */
  readonly projectIds: readonly string[];
  /**
   * Roles whose scope is the whole organization rather than an explicit project list.
   * Derived at session build time from role, kept here so the evaluator stays pure.
   */
  readonly hasOrgWideScope: boolean;
  /**
   * platform-admin v2 · PA-01 (SPEC §3.3). Live per-member overrides from
   * `membership_permission_overrides`, loaded by the membership resolver. `allow` adds a
   * capability on top of the role; `deny` removes one. Absent means none. Step 3 of
   * {@link authorize} is the only reader; org policy and the internal-only guard still run after
   * it, so an override can never widen a client principal into internal content.
   */
  readonly overrides?: PermissionOverrides;
}

/** PA-01. A member's live allow/deny overrides, as the resolver loads them. */
export interface PermissionOverrides {
  readonly allow: readonly Capability[];
  readonly deny: readonly Capability[];
}

/**
 * PA-01. Does the principal's role, as adjusted by their overrides, hold `capability`? The
 * ceiling half of step 3, shared with the route guard so both read overrides the same way.
 * A deny never applies to the hidden `platform_support` role (SPEC §3.3).
 */
export function principalHoldsCapability(
  principal: Pick<Principal, 'role' | 'overrides'>,
  capability: Capability,
): boolean {
  return ceilingCheck(principal, capability) === null;
}

/** The capability set a principal holds after overrides: role ∪ allow − deny. */
export function effectiveCapabilitySet(
  principal: Pick<Principal, 'role' | 'overrides'>,
): ReadonlySet<Capability> {
  const base = capabilitySetFor(principal.role);
  if (!principal.overrides) return base;
  const out = new Set<Capability>(base);
  for (const capability of principal.overrides.allow) out.add(capability);
  if (!isPlatformSupportRole(principal.role)) {
    for (const capability of principal.overrides.deny) out.delete(capability);
  }
  return out;
}

function ceilingCheck(
  principal: Pick<Principal, 'role' | 'overrides'>,
  capability: Capability,
): 'capability_not_in_role_ceiling' | 'capability_denied_by_override' | null {
  const overrides = principal.overrides;
  if (overrides?.deny.includes(capability) === true && !isPlatformSupportRole(principal.role)) {
    return 'capability_denied_by_override';
  }
  const inRole = capabilitySetFor(principal.role).has(capability);
  if (inRole || overrides?.allow.includes(capability) === true) return null;
  return 'capability_not_in_role_ceiling';
}

/** The thing being acted upon. Loaded tenant-scoped before the decision (§3 step 4). */
export interface ResourceContext {
  readonly organizationId: string;
  /** Null for org-level resources such as organization settings. */
  readonly projectId: string | null;
  readonly audience: Audience;
  /** For client-facing objects: which client organization the projection belongs to. */
  readonly clientOrganizationId?: string | null;
  /** Whether the principal is an assigned reviewer on this object, where relevant. */
  readonly isAssignedReviewer?: boolean;
  /** Whether the resource has been archived or soft-deleted. */
  readonly lifecycle?: 'active' | 'archived' | 'soft_deleted';
  /**
   * For deliverable content: whether the version has been published to the client.
   * Unpublished versions are invisible to clients regardless of audience.
   */
  readonly isPublished?: boolean;
  /**
   * R7. For a conversation: what it is. A `group` or `direct` conversation has no project, so the
   * project relation cannot gate it — membership of the conversation does (`conversationMember`).
   * Absent or `project_channel` keeps the project-channel rules unchanged.
   */
  readonly conversationKind?: 'project_channel' | 'group' | 'direct';
  /** R7. Whether the principal has a `conversation_memberships` row on this conversation. */
  readonly conversationMember?: boolean;
}

/**
 * Organization policy may narrow a capability. `25-AUTH-AND-TENANT-ISOLATION` §4: policy
 * "may narrow, never silently widen external access", so this can only remove.
 */
export interface OrganizationPolicy {
  /** Capabilities disabled organization-wide, regardless of role. */
  readonly disabledCapabilities?: readonly Capability[];
}

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly capability: Capability;
  readonly resource: ResourceContext;
  readonly policy?: OrganizationPolicy;
}

/** Stable machine-readable denial reasons. Safe to log; never contain content. */
export type DenialCode =
  | 'membership_inactive'
  | 'tenant_mismatch'
  | 'capability_not_in_role_ceiling'
  /** PA-01. The role holds it, but a live per-member deny override removes it. */
  | 'capability_denied_by_override'
  | 'capability_disabled_by_policy'
  | 'capability_is_internal_only'
  | 'client_organization_mismatch'
  | 'not_project_member'
  /** R7. A group or direct conversation is reachable only by its members. */
  | 'not_conversation_member'
  | 'audience_internal'
  | 'not_published'
  | 'not_assigned_reviewer'
  | 'resource_not_active';

export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: DenialCode;
      /** Human-readable, non-sensitive. Never includes object content or other tenants' data. */
      readonly detail: string;
    };

const deny = (code: DenialCode, detail: string): AuthorizationDecision => ({
  allowed: false,
  code,
  detail,
});

const ALLOW: AuthorizationDecision = { allowed: true };

/** Capabilities whose object-level gate is reviewer assignment rather than membership. */
const REVIEWER_GATED: ReadonlySet<Capability> = new Set<Capability>(['approval.decide']);

/** Capabilities that read or write object content and therefore need a relation check. */
const RELATION_GATED: ReadonlySet<Capability> = new Set<Capability>([
  'conversation.read',
  'conversation.write',
  'conversation.moderate',
  /**
   * `12-PERMISSION-MATRIX` §2 "View client projection": Manager/Moderator/Member = Project,
   * Guest = Explicit, org-wide roles = Scope. Without the relation check an internal guest or
   * member read every project's portal projection in the tenant (audit F18). Client principals
   * are unaffected: rule 10 already bounds them to the projects shared with their organization.
   */
  'client_projection.read',
  'work.read',
  'work.create',
  'work.update',
  'work.transition',
  'client_request.triage',
  'deliverable.create',
  'deliverable.review',
  'deliverable.publish',
  'approval.read',
  'approval.decide',
  'file.upload',
  'file.download',
  'project.manage',
  'project.member.manage',
]);

/**
 * Decide whether a principal may exercise a capability against a resource.
 *
 * Ordering follows `25-AUTH-AND-TENANT-ISOLATION` §3 and is deliberate: cheap, categorical checks that
 * cannot leak information run before anything that depends on object facts. In particular
 * the tenant check runs before any relation reasoning, per §3 step 3 — "reject tenant
 * mismatch before object lookup where possible".
 */
export function authorize(request: AuthorizationRequest): AuthorizationDecision {
  const { principal, capability, resource, policy } = request;

  // 1. Active membership. A suspended or expired membership authorizes nothing, and this
  //    is checked first so a revoked principal cannot probe object existence.
  if (principal.membershipStatus !== 'active') {
    return deny(
      'membership_inactive',
      `membership is ${principal.membershipStatus}; no capability is exercisable`,
    );
  }

  // 2. Tenant. Before object reasoning (§3 step 3).
  if (principal.organizationId !== resource.organizationId) {
    return deny('tenant_mismatch', 'resource belongs to a different organization');
  }

  // 2a. R7 member-gated chats. A group or a direct conversation belongs to no project: its
  //     members are its relation, for everyone. A client principal may reach a GROUP it is in
  //     (read; write unless client_viewer) — the only client path to `conversation.*`, decided
  //     here because the ceiling and the internal-only guard below would refuse it. Policy, deny
  //     overrides and lifecycle still apply; a direct conversation is never client-reachable here.
  const memberGatedChat =
    resource.conversationKind !== undefined &&
    resource.conversationKind !== 'project_channel' &&
    CLIENT_GROUP_CHAT_CAPABILITIES.includes(capability);
  if (memberGatedChat && resource.conversationMember !== true) {
    return deny('not_conversation_member', 'principal is not a member of this conversation');
  }
  const isClientPrincipal = principal.kind === 'client' || isClientRole(principal.role);
  if (memberGatedChat && isClientPrincipal && resource.conversationKind === 'group') {
    if (principal.overrides?.deny.includes(capability) === true) {
      return deny('capability_denied_by_override', `${capability} is removed for this member`);
    }
    if (capability === 'conversation.write' && principal.role === CLIENT_GROUP_READ_ONLY_ROLE) {
      return deny('capability_not_in_role_ceiling', `role ${principal.role} may not post`);
    }
    if (policy?.disabledCapabilities?.includes(capability)) {
      return deny('capability_disabled_by_policy', `${capability} is disabled by policy`);
    }
    if ((resource.lifecycle ?? 'active') !== 'active') {
      return deny('resource_not_active', `resource is ${resource.lifecycle}`);
    }
    return ALLOW;
  }

  // 3. Role ceiling — a built-in role's ceiling, or a custom role's exact capability set —
  //    adjusted by the member's live overrides (PA-01, SPEC §3.3): allowed when the role holds
  //    it or an allow names it, and no deny names it. Org policy (4) and the internal-only
  //    guard (5) still run after, so an override narrows or widens only inside them.
  const ceiling = ceilingCheck(principal, capability);
  if (ceiling === 'capability_denied_by_override') {
    return deny(ceiling, `${capability} is removed for this member by an override`);
  }
  if (ceiling !== null) {
    const label = customRoleIdOf(principal.role) === null ? principal.role : 'custom role';
    return deny('capability_not_in_role_ceiling', `role ${label} does not include ${capability}`);
  }

  // 4. Organization policy may narrow, never widen.
  if (policy?.disabledCapabilities?.includes(capability)) {
    return deny(
      'capability_disabled_by_policy',
      `${capability} is disabled by organization policy`,
    );
  }

  // 5. Independent internal-only guard. This intentionally duplicates the role table:
  //    if a future edit wrongly grants an internal capability to a client role, this
  //    still denies. The cost of a mistake here is a client reading internal content.
  const isClient = isClientPrincipal;
  if (isClient && isInternalOnlyCapability(capability)) {
    return deny(
      'capability_is_internal_only',
      `${capability} is never available to an external principal`,
    );
  }

  // 6. Object lifecycle. Archived and soft-deleted objects are readable by internal
  //    principals for history, but never writable, and never visible to clients.
  const lifecycle = resource.lifecycle ?? 'active';
  if (lifecycle !== 'active') {
    const isRead = capability.endsWith('.read') || capability === 'file.download';
    if (!isRead || isClient) {
      return deny('resource_not_active', `resource is ${lifecycle}`);
    }
  }

  // ── Client principals ──────────────────────────────────────────────────────
  if (isClient) {
    // 7. Never across client organizations, even inside the same tenant
    //    (`04-SECURITY-PRIVACY` §5: no client can discover another client organization).
    if (
      resource.clientOrganizationId != null &&
      resource.clientOrganizationId !== principal.clientOrganizationId
    ) {
      return deny(
        'client_organization_mismatch',
        'resource belongs to a different client organization',
      );
    }

    // 8. Internal audience is invisible to external principals, unconditionally.
    if (!isClientReadableAudience(resource.audience)) {
      return deny('audience_internal', 'resource audience is internal');
    }

    // 9. Unpublished content is not client-reachable even when its audience allows it.
    //    Audience is intent; publication is the act that creates the projection.
    if (resource.isPublished === false) {
      return deny('not_published', 'resource has not been published to the client');
    }

    // 10. The project must actually be shared with this client organization.
    if (resource.projectId != null && !principal.projectIds.includes(resource.projectId)) {
      return deny('not_project_member', 'project is not shared with this client organization');
    }

    // 11. Deciding an approval additionally requires current reviewer authority
    //     (`25-AUTH-AND-TENANT-ISOLATION` §8, US-C03).
    if (REVIEWER_GATED.has(capability) && resource.isAssignedReviewer !== true) {
      return deny('not_assigned_reviewer', 'principal is not an assigned reviewer');
    }

    return ALLOW;
  }

  // ── Internal principals ────────────────────────────────────────────────────

  // 12. Project relation. Org-wide roles (owner, org admin, workspace admin within scope)
  //     derive access from scope rather than an explicit membership row.
  if (
    RELATION_GATED.has(capability) &&
    resource.projectId != null &&
    !principal.hasOrgWideScope &&
    !principal.projectIds.includes(resource.projectId)
  ) {
    return deny('not_project_member', 'principal is not a member of this project');
  }

  // 13. Reviewer authority applies to internal reviewers too — `12-PERMISSION-MATRIX` §2
  //     records "Approve governed version: If reviewer" for every internal role.
  if (REVIEWER_GATED.has(capability) && resource.isAssignedReviewer !== true) {
    return deny('not_assigned_reviewer', 'principal is not an assigned reviewer');
  }

  return ALLOW;
}

/** Convenience for call sites that only need the boolean. Prefer `authorize` for the code. */
export function isAuthorized(request: AuthorizationRequest): boolean {
  return authorize(request).allowed;
}

/**
 * May this principal put `capability` into a custom role, or hand a role carrying it to someone?
 * (ADM-08)
 *
 * The rule is "you can only grant what you hold yourself", decided by the real evaluator against
 * an org-wide internal resource, so a role can never widen access past the person defining it.
 *
 * The owner is the one exception (ADM-08, A1): an active internal principal with the built-in
 * `owner` role may grant any capability, `approval.decide` included. The owner's ceiling is every
 * capability, so nothing an owner grants widens access past its author. The owner is still checked
 * for an active membership, the tenant, the ceiling and organization policy; only the per-object
 * reviewer relation is taken as held, because a role does not carry that relation: whoever is given
 * the role still needs it on each approval. Everyone else (org_admin included) keeps the SEC-011
 * refusal of a reviewer-gated capability.
 */
export function mayGrantCapability(
  principal: Principal,
  capability: Capability,
  organizationId: string,
): AuthorizationDecision {
  // PA-01: a live Support session (`platform_support`) carries the owner's ceiling and grants
  // as the owner does (SPEC §3.2 — ownership can be transferred from inside support mode).
  const isOwner =
    principal.kind === 'internal' &&
    (principal.role === 'owner' || isPlatformSupportRole(principal.role));
  return authorize({
    principal,
    capability,
    resource: {
      organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
      ...(isOwner ? { isAssignedReviewer: true } : {}),
    },
  });
}
