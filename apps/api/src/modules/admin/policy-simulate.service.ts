import { authorize, capabilitiesFor, clientCeilingViolations, isClientRole } from '@tmanage/domain';
import type { Audience, Capability, Principal, PrincipalKind, Role } from '@tmanage/domain';
import { AUDIENCES, CAPABILITIES } from '@tmanage/domain';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { PrincipalRepository } from '../tenancy/principal.repository.js';
import { PolicySimulateRepository } from './policy-simulate.repository.js';
import type { PolicySimulateReads, SimulatedMember } from './policy-simulate.repository.js';

/**
 * Access-policy simulation (Administration module 18, x196) — the read-only "can member X do Y?"
 * evaluator the audit named absent (Admin: policies stored in x174 with no way to test their effect).
 *
 * ## Why this reuses the real evaluator, and reuses nothing else
 *
 * The one rule that makes this feature safe to ship is that it must never *lie* about access. A
 * simulator that re-implemented the decision would drift from the authoritative one the moment either
 * changed, and an administrator would grant or revoke a role on the strength of a wrong answer. So the
 * decision is made by the very same `authorize()` the request path uses, over a `Principal` assembled
 * from the very same {@link PrincipalRepository.projectScope} the session builder uses. This service
 * adds no rule of its own: it loads the member's stored facts, tenant-scoped, and hands them to the
 * evaluator. Everything below the evaluator call is data assembly, not policy.
 *
 * ## Tenant scope before compute (the Known trap)
 *
 * Every lookup — the organization, the member — carries `organization_id = context.organizationId`, so a
 * member of another studio is never read, never simulated, and never disclosed: a context whose
 * organization is not in this tenant is a 404 before any compute, and a member id not in this tenant is
 * a 404 the same way (indistinguishable from "no such member", which is the point). The evaluator is
 * reached only after the caller's own `org.manage` has been authorized with the real evaluator.
 *
 * ## Read-only
 *
 * The service opens no transaction and writes nothing. It computes a decision and returns it.
 */

/** The resource facts the caller may vary. All optional; each defaults to an org-level internal read. */
export interface PolicySimulationContextInput {
  /** The project the action is against, or null/omitted for an organization-level resource. */
  readonly projectId?: string | null;
  /** The resource's audience. Defaults to `internal`. */
  readonly audience?: Audience;
}

/** The POST body: which member, which capability, and the resource context to evaluate against. */
export interface PolicySimulationInput {
  readonly memberId: string;
  readonly capability: string;
  readonly context?: PolicySimulationContextInput;
}

/**
 * The simulation result — the decision the live evaluator would reach for this member, with the deciding
 * rule made explicit. This is a diagnostic surface behind `org.manage`, so it deliberately carries the
 * evaluator's `denialCode` (an administrator inspecting their own tenant's policy is exactly who that
 * detail is for); it is a 200 response body, never an error envelope, so the coarse-refusal discipline
 * of `errors.ts` does not apply to it.
 */
export interface PolicySimulationView {
  readonly result: {
    readonly memberId: string;
    readonly role: string;
    readonly capability: string;
    readonly allowed: boolean;
    /** The role that carries the capability (for an allow) or the evaluator's denial code (for a deny). */
    readonly decidingRule: string;
    /** The evaluator's non-sensitive human-readable reason. */
    readonly detail: string;
    /** The stable machine-readable denial code, or null when allowed. */
    readonly denialCode: string | null;
    /** 56-28: internal capabilities a client principal's effective set carries (empty normally). */
    readonly warnings: readonly SimulationWarning[];
  };
}

export interface SimulationWarning {
  readonly code: 'client_internal_capability';
  readonly capability: Capability;
}

/** 56-28: one warning per capability outside the client allowlist, for a client principal only. */
export function clientCeilingWarnings(kind: PrincipalKind, role: string): SimulationWarning[] {
  if (kind !== 'client') return [];
  return clientCeilingViolations(role as Role, capabilitiesFor(role as Role)).map((capability) => ({
    code: 'client_internal_capability',
    capability,
  }));
}

export class PolicySimulateService {
  constructor(
    private readonly reads: PolicySimulateReads = new PolicySimulateRepository(),
    private readonly principals: PrincipalRepository = new PrincipalRepository(),
  ) {}

  /**
   * Validate the body into a typed input, or throw a 400. Shape only — a malformed member id, a missing
   * capability, or an out-of-vocabulary audience is a bad request. Whether the capability names a real
   * capability, and whether the member exists in this tenant, are decided later (400 and 404
   * respectively), tenant-scoped.
   */
  parse(body: unknown): PolicySimulationInput {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw this.badRequest('body', 'A simulation request body is required.');
    }
    const record = body as Record<string, unknown>;
    const memberId = record['memberId'];
    if (typeof memberId !== 'string' || memberId.trim().length === 0) {
      throw this.badRequest('memberId', 'A member id is required.');
    }
    const capability = record['capability'];
    if (typeof capability !== 'string' || capability.trim().length === 0) {
      throw this.badRequest('capability', 'A capability is required.');
    }
    const rawContext = record['context'];
    if (rawContext === undefined) {
      return { memberId, capability };
    }
    if (typeof rawContext !== 'object' || rawContext === null || Array.isArray(rawContext)) {
      throw this.badRequest('context', 'Context must be an object.');
    }
    const ctx = rawContext as Record<string, unknown>;
    const context: { projectId: string | null; audience?: Audience } = { projectId: null };
    const rawProjectId = ctx['projectId'];
    if (rawProjectId !== undefined && rawProjectId !== null) {
      if (typeof rawProjectId !== 'string' || rawProjectId.trim().length === 0) {
        throw this.badRequest('context.projectId', 'projectId must be a non-empty string or null.');
      }
      context.projectId = rawProjectId;
    }
    const rawAudience = ctx['audience'];
    if (rawAudience !== undefined) {
      if (typeof rawAudience !== 'string' || !AUDIENCES.includes(rawAudience as Audience)) {
        throw this.badRequest('context.audience', 'audience is not a known audience.');
      }
      context.audience = rawAudience as Audience;
    }
    return { memberId, capability, context };
  }

  /**
   * Simulate the decision. Ordering mirrors x174: the organization is resolved tenant-scoped first (404,
   * the Known trap), then the caller's own `org.manage` is authorized with the real evaluator (403),
   * then the capability is validated (400) and the member is resolved tenant-scoped (404) before the
   * evaluator is reached for the simulation itself.
   */
  async simulate(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    input: PolicySimulationInput,
  ): Promise<PolicySimulationView> {
    // 1. The organization must exist in this tenant (the Known trap): a cross-tenant context is a 404
    //    before authorize and before any compute, never a simulation over another studio's facts.
    if (!(await this.reads.organizationExists(runner, context))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    // 2. The caller's own `org.manage` — the real org-wide, tenant-checked decision. The decorator is the
    //    coarse HTTP gate; this is the decision a controller test exercises directly. A denial is a 403.
    this.requireOrgManage(principal, context);

    // 3. The capability must name a real capability. An unknown capability is a bad request, not a deny:
    //    the evaluator cannot answer for a capability that does not exist.
    if (!CAPABILITIES.includes(input.capability as Capability)) {
      throw this.badRequest('capability', 'That capability is not recognised.');
    }
    const capability = input.capability as Capability;

    // 4. The member must exist in this tenant. Resolved with an `organization_id` predicate, so a member
    //    of another studio is a 404 — indistinguishable from an unknown member, which is the boundary.
    const member = await this.reads.findMember(runner, context, input.memberId);
    if (!member) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    // 5. Assemble the member's Principal exactly as the session builder does — the same project-scope
    //    read, the same principal shape — so the evaluator reasons about the real relation facts.
    const targetPrincipal = await this.buildPrincipal(runner, context, member);

    // 6. The authoritative decision. No rule is added here.
    const decision = authorize({
      principal: targetPrincipal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: input.context?.projectId ?? null,
        audience: input.context?.audience ?? 'internal',
        lifecycle: 'active',
      },
    });

    return {
      result: {
        memberId: input.memberId,
        role: member.role,
        capability,
        allowed: decision.allowed,
        decidingRule: decision.allowed ? `role:${member.role}` : decision.code,
        detail: decision.allowed
          ? `role ${member.role} holds ${capability} and every tenant, relation and audience check passed`
          : decision.detail,
        denialCode: decision.allowed ? null : decision.code,
        warnings: clientCeilingWarnings(targetPrincipal.kind, member.role),
      },
    };
  }

  /**
   * Build the member's `Principal` from stored facts, reusing {@link PrincipalRepository.projectScope}
   * for the relation set so the evaluator sees exactly what a live session would. The target's own
   * context (its user and kind) drives the project-scope read; the tenant is the caller's.
   *
   * The one field taken from the row rather than assumed is the membership status: the session resolver
   * only ever produces active principals, but the simulator answers for any member, and a suspended
   * member is honestly denied by the evaluator's first check.
   */
  private async buildPrincipal(
    runner: TenantQueryRunner,
    context: TenantContext,
    member: SimulatedMember,
  ): Promise<Principal> {
    // The stored role is a `VARCHAR(64)`; `isClientRole` classifies it, and an unrecognised value has no
    // capability ceiling, so the evaluator denies it. No re-validation is needed here.
    const role = member.role as Role;
    const kind = isClientRole(member.role) ? 'client' : 'internal';
    const targetContext = createTenantContext({
      organizationId: context.organizationId,
      userId: member.userId,
      principalKind: kind,
      // membershipId is not consulted by projectScope; a valid tenant uuid is all createTenantContext
      // requires, and the member's own user id is one.
      membershipId: member.userId,
      capabilities: [],
      policyVersion: '1',
      correlationId: context.correlationId,
    });
    const projectIds = await this.principals.projectScope(runner, targetContext, {
      context: targetContext,
      role,
      // An internal membership belongs to no client organization; a client-kind role stored in
      // `memberships` has none recorded, so it reaches no project — the safe default.
      clientOrganizationId: null,
      hasOrgWideScope: member.hasOrgWideScope,
      workspaceScopeId: member.workspaceScopeId,
    });
    return {
      userId: member.userId,
      organizationId: context.organizationId,
      kind,
      role,
      membershipId: member.userId,
      // MEMBERSHIP_STATUS is invited|active|suspended|offboarded; the evaluator's contract is
      // active|suspended|expired. Only `active` is active — every other status is honestly non-active,
      // which the evaluator denies as `membership_inactive`.
      membershipStatus: member.status === 'active' ? 'active' : 'suspended',
      clientOrganizationId: null,
      projectIds,
      hasOrgWideScope: member.hasOrgWideScope,
    };
  }

  /**
   * The caller's real `org.manage` decision — org-wide, so `projectId: null` and an internal audience,
   * the same shape x174 uses for the same capability. An internal role holding `org.manage` passes; a
   * client is refused (`org.manage` is internal-only), and a cross-tenant principal by the tenant check
   * inside `authorize`. A denial is a 403 with the machine-readable cause on the audit code only.
   */
  private requireOrgManage(principal: Principal, context: TenantContext): void {
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `policy_simulate:${verdict.code}`,
      );
    }
  }

  private badRequest(field: string, message: string): ApiError {
    return new ApiError(400, 'validation_failed', message, [{ field, message }]);
  }
}
