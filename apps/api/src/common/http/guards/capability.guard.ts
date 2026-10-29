import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  hasCapability,
  isClientRole,
  isInternalOnlyCapability,
  principalHoldsCapability,
} from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../errors.js';
import { IS_PUBLIC, REQUIRED_CAPABILITY, SKIPS_TENANT } from '../decorators.js';
import { requireRequestState } from '../request-state.js';
import type { RequestState } from '../request-state.js';
import { AUDIT_SERVICE } from '../tokens.js';
import type { AuditService } from '../../../modules/audit/audit.service.js';

/**
 * Spec §3 step 5 — the coarse, route-level half of the authorization decision.
 *
 * This guard answers "may a principal of this role exercise this capability in this tenant at
 * all?" It deliberately cannot answer "…against this object", because the object has not been
 * loaded yet: audience, project relation, publication state and reviewer authority are facts
 * about a row, and a guard that pretended to check them would have to fetch that row outside
 * a repository — which the lint boundary forbids and ADR-0001 layer 4 exists to prevent.
 *
 * So it checks the **role ceiling** and nothing else: does this role include this capability,
 * and — independently — is this an internal-only capability being asked for by an external
 * principal. No object, no audience, no project relation.
 *
 * An earlier version called `authorize()` here with a synthetic organization-level resource at
 * audience `internal`. It was wrong, and the suite caught it: `authorize()` denies any client
 * principal reading an `internal` resource, so **every** client route 403'd at the guard before
 * the service could apply the real, object-level decision. The mistake was passing a made-up
 * resource to a function whose whole contract is to reason about a real one — a route-level
 * check has no object, so it must not pretend to have one.
 *
 * The object-level decision is the service's, using the same `authorize()` with a
 * `ResourceContext` built from the loaded row. Two calls, two different questions; the guard
 * is not a substitute for the second, and `25-AUTH-AND-TENANT-ISOLATION` §3 is explicit that
 * "route guards are UX only" and the API must authorize every action regardless.
 *
 * ## An unannotated tenant route is refused
 *
 * A route that reached here with no `@RequireCapability` is one whose author did not say what
 * it needs. That is treated as a mistake and denied, rather than allowed on the grounds that
 * nothing was asked for.
 *
 * ## Every refusal here is a security event — §12, AUD-001
 *
 * "Denied sensitive attempts are security events with safe metadata." This guard is where
 * that sentence is implemented, and the choice of *this* guard rather than the exception
 * filter is the substance of it:
 *
 * - By the time a request reaches here, `TenantContextGuard` has proved an active membership,
 *   so there **is** an organization to file the event under. `audit_events.organization_id` is
 *   `NOT NULL` with a foreign key, so a denial from any earlier guard — no session, bad CSRF
 *   token, no membership for the named organization — has nowhere to be written and is not
 *   recorded. That is a limitation, not a design: it is named in
 *   `docs/implementation-status.md` rather than hidden behind a nullable column.
 * - Every attempt that gets this far is *authenticated and inside a tenant*, which is what
 *   makes it sensitive and, equally, what stops the table from becoming a function of what an
 *   anonymous crawler chooses to send.
 * - The guard knows the capability. A filter does not: `ExceptionFilter.catch` receives an
 *   `ArgumentsHost`, not an `ExecutionContext`, so the route's metadata is out of reach there
 *   and the event would have to describe the refusal without naming what was refused.
 *
 * The write is awaited, and it cannot fail the request: `AuditService.recordDenial` swallows
 * its own errors and returns whether anything was written. Awaiting rather than leaving a
 * floating promise costs one transaction on a path that has already failed, and buys a denial
 * that is durable before the response is sent — and a test that can observe it without a
 * sleep.
 *
 * Object-level denials are **not** recorded here, because they do not pass through here.
 * `ProjectsService` answers "you may not see this project" with 404, deliberately, so that a
 * refusal cannot confirm a row exists; auditing every such miss would turn the table into a
 * log of everything an enumerating client guessed at.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIPS_TENANT, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip || isPublic) return true;

    const capability = this.reflector.getAllAndOverride<Capability>(REQUIRED_CAPABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<object>();
    const state = requireRequestState(request);

    if (!capability) {
      throw await this.denial(state, undefined, 'route_declares_no_capability');
    }

    const principal = state.principal;
    if (!principal) {
      throw new ApiError(
        401,
        'unauthenticated',
        MESSAGES.unauthenticated,
        undefined,
        'no_principal',
      );
    }

    // The two ceiling checks, kept independent on purpose. The second intentionally duplicates
    // the role table: if a future edit wrongly grants an internal capability to a client role,
    // this still denies, and the cost of that particular mistake is a client reading internal
    // content. `authorize()` makes the same check for the same reason.
    // PA-01 (SPEC §3.3): a per-member override can add a capability the role lacks or take one
    // away; the route gate reads the same effective set `authorize()` step 3 does.
    if (!principalHoldsCapability(principal, capability)) {
      throw await this.denial(
        state,
        capability,
        hasCapability(principal.role, capability)
          ? 'capability_denied_by_override'
          : 'capability_not_in_role_ceiling',
      );
    }

    const isClient = principal.kind === 'client' || isClientRole(principal.role);
    if (isClient && isInternalOnlyCapability(capability)) {
      throw await this.denial(state, capability, 'capability_is_internal_only');
    }

    return true;
  }

  /**
   * Record the refusal and return the error to raise.
   *
   * It returns the `ApiError` rather than throwing it so that every call site reads
   * `throw await this.denial(...)`. That matters to the compiler, not only to the eye: a
   * `throw` is a terminating statement, so control-flow narrowing survives it, whereas
   * awaiting a helper typed `Promise<never>` does not narrow anything — TypeScript has no way
   * to know the awaited value is never produced. Without this shape, `capability` stays
   * `Capability | undefined` after the check that proved otherwise.
   *
   * The event is written only when a tenant context exists. It always does on this path
   * today; the guard is written not to assume it, because the day a route is added that skips
   * `TenantContextGuard` but not this one, the failure mode should be an unrecorded denial
   * rather than a foreign-key error on an unrelated request.
   */
  private async denial(
    state: RequestState,
    capability: Capability | undefined,
    auditCode: string,
  ): Promise<ApiError> {
    if (state.tenant) {
      await this.audit.recordDenial(state.tenant, 'security.capability_denied', {
        status: 403,
        auditCode,
        ...(capability ? { capability } : {}),
      });
    }

    return new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, auditCode);
  }
}
