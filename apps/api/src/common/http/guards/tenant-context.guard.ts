import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../errors.js';
import { SKIPS_TENANT, IS_PUBLIC } from '../decorators.js';
import { requireRequestState } from '../request-state.js';
import { MEMBERSHIP_RESOLVER, PRINCIPAL_REPOSITORY, TENANT_DATABASE } from '../tokens.js';
import {
  MembershipNotResolvedError,
  SUSPENDED_MESSAGE,
} from '../../../modules/tenancy/membership-resolver.repository.js';
import type { MembershipResolver } from '../../../modules/tenancy/membership-resolver.repository.js';
import type { PrincipalRepository } from '../../../modules/tenancy/principal.repository.js';
import type { TenantDatabase } from '../../database/tenant-context.js';
import { withActorChannel } from '../../database/tenant-context.js';

/**
 * Spec §3 steps 2 to 4 — resolve the organization, build the context, load the policy facts.
 *
 * This is the guard that turns a URL segment into authority, so it is the one place where
 * getting the direction of trust backwards would undo the whole access layer. §2 states the
 * rule it implements:
 *
 *   "The organization slug/ID from the route is accepted only after the API confirms an active
 *    internal or client membership."
 *
 * So `params.orgSlug` is passed to `MembershipResolver.resolve()` as a **claim under test**,
 * and what comes back is bound to the organization the membership row proves. The slug is
 * never written into a `TenantContext` directly, and nothing downstream reads it again.
 *
 * ## Why a failure is 404 and not 403
 *
 * `MembershipNotResolvedError` covers both "no such organization" and "you are not in it", by
 * design — it carries one message for every cause. Rendering that as 403 would reintroduce at
 * the HTTP layer exactly the distinction the resolver refuses to make, because a 403 confirms
 * the organization exists. Slugs are company names and therefore guessable, so that would be a
 * customer-enumeration oracle for anyone holding any valid session.
 *
 * 404 with a fixed message keeps the two indistinguishable. The database suite asserts the
 * response to a real-but-unreachable slug is **byte-identical** to the response for a slug
 * that does not exist.
 *
 * ## Step 4 runs on the scoped path
 *
 * The resolver waives ADR-0001 layer 3 because it is what establishes the tenant. Nothing
 * after it does. `PrincipalRepository.load()` is therefore called inside an ordinary
 * `TenantDatabase.read()` bound to the freshly-built context, and a test asserts a whole
 * authenticated request emits no guard event at all — which is what keeps the waiver one read
 * rather than a mode the request stays in.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MEMBERSHIP_RESOLVER) private readonly resolver: MembershipResolver,
    @Inject(PRINCIPAL_REPOSITORY) private readonly principals: PrincipalRepository,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
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

    const request = context.switchToHttp().getRequest<{
      readonly params: Record<string, string | undefined>;
    }>();
    const state = requireRequestState(request);

    const session = state.session;
    if (!session) {
      throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, 'no_session');
    }

    const slug = request.params['orgSlug'];
    if (!slug) {
      // A tenant-scoped route with no `:orgSlug` segment is a routing mistake, and it must not
      // degrade into "resolve nothing and continue without a tenant".
      throw new Error(
        'TenantContextGuard ran on a route with no :orgSlug parameter. Mark it @NoTenant() if ' +
          'it is genuinely not tenant-scoped.',
      );
    }

    let resolved;
    try {
      resolved = await this.resolver.resolve({
        userId: session.userId,
        organization: { slug },
        correlationId: state.correlationId,
      });
    } catch (error) {
      if (error instanceof MembershipNotResolvedError) {
        // 0206. A proved member of a suspended company is told so (403) instead of the 404 —
        // the resolver raises this only after the membership row matched, so no outsider sees it.
        if (error.code === 'organization_suspended') {
          throw new ApiError(403, 'forbidden', SUSPENDED_MESSAGE, undefined, error.code);
        }
        throw new ApiError(404, 'not_found', MESSAGES.organizationNotFound, undefined, error.code);
      }
      throw error;
    }

    // A personal access token may act only in the organization it was created in (0202). The
    // resolver has just proved the member belongs to the requested org, but a token is bound to
    // ONE org, not to every org its member is in — so a resolved org that is not the token's is
    // refused here, before any principal is loaded. The refusal is the same 404 (and the same
    // fixed `organizationNotFound` body) a non-member or unknown-slug attempt gets, so a token
    // cannot distinguish "that org is not yours" from "that org does not exist"; the specific
    // cause travels to the log on the audit code, exactly as `MembershipNotResolvedError` does.
    const patBinding = state.personalAccessToken;
    if (
      state.authScheme === 'personal_access_token' &&
      patBinding !== undefined &&
      resolved.context.organizationId !== patBinding.organizationId
    ) {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.organizationNotFound,
        undefined,
        'token_organization_mismatch',
      );
    }

    state.membership = resolved;
    // AUT-08. A personal access token is the AI-assistant / MCP channel, so tag the context the
    // services will act under; the audit append stamps it onto the metadata it writes, and the
    // item's activity feed reads that back as "via AI assistant". A cookie session is untagged,
    // leaving its context — and every audit row it writes — exactly as before.
    state.tenant =
      state.authScheme === 'personal_access_token'
        ? withActorChannel(resolved.context, 'ai_assistant')
        : resolved.context;
    state.principal = await this.database.read(resolved.context, (runner) =>
      this.principals.load(runner, resolved),
    );

    return true;
  }
}
