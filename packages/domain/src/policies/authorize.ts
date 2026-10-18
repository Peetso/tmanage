import {
  hasCapability,
  isClientRole,
  isInternalOnlyCapability,
  type Capability,
  type PrincipalKind,
  type Role,
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
  readonly role: Role;
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
  | 'capability_disabled_by_policy'
  | 'capability_is_internal_only'
  | 'client_organization_mismatch'
  | 'not_project_member'
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

  // 3. Role ceiling.
  if (!hasCapability(principal.role, capability)) {
    return deny(
      'capability_not_in_role_ceiling',
      `role ${principal.role} does not include ${capability}`,
    );
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
  const isClient = principal.kind === 'client' || isClientRole(principal.role);
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
 * The owner is the one principal for whom that question has a fixed answer: the owner's ceiling is
 * every capability, so nothing an owner grants is an escalation. Asking the evaluator anyway
 * refused the owner every reviewer-gated capability (`approval.decide` needs an assignment no
 * org-wide resource carries), which is why "there is nothing an owner cannot do" read as false.
 * An owner is still checked for an active membership, the tenant, the ceiling and organization
 * policy; only the per-object reviewer relation is taken as held, because a role does not carry
 * that relation — whoever is given the role still needs it on each approval.
 */
export function mayGrantCapability(
  principal: Principal,
  capability: Capability,
  organizationId: string,
): AuthorizationDecision {
  const isOwner = principal.kind === 'internal' && principal.role === 'owner';
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
