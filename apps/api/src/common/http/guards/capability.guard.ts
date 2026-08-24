import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasCapability, isClientRole, isInternalOnlyCapability } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../errors.js';
import { IS_PUBLIC, REQUIRED_CAPABILITY, SKIPS_TENANT } from '../decorators.js';
import { requireRequestState } from '../request-state.js';

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
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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
    if (!capability) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'route_declares_no_capability',
      );
    }

    const request = context.switchToHttp().getRequest<object>();
    const state = requireRequestState(request);
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
    if (!hasCapability(principal.role, capability)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'capability_not_in_role_ceiling',
      );
    }

    const isClient = principal.kind === 'client' || isClientRole(principal.role);
    if (isClient && isInternalOnlyCapability(capability)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'capability_is_internal_only',
      );
    }

    return true;
  }
}
