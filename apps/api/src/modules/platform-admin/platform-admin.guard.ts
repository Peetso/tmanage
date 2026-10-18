import { createParamDecorator, Inject, Injectable, SetMetadata } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { isPlatformAdminEmail } from './platform-admin.access.js';
import type { PlatformAdminAccount, PlatformStepUp } from './platform-admin.repository.js';

/**
 * The gate in front of every `/v1/platform/*` route. It runs after the global session guard
 * (so a session exists) and the routes are `@NoTenant()`, so no organization role is ever
 * consulted — an owner of every company on the server is refused exactly like a stranger.
 *
 * In order, each a refusal on its own:
 *
 * 1. **The feature is on** — `PLATFORM_ADMIN_EMAILS` names at least one address.
 * 2. **A browser session**, not a personal access token: an API token is not a person at a
 *    keyboard and cannot re-confirm a password.
 * 3. **A verified email on the list**, compared exactly and case-insensitively.
 * 4. **A fresh step-up** — the password (and the MFA code when MFA is set up) confirmed in
 *    THIS session within the last 15 minutes — for every route except reading one's own
 *    status and making the step-up itself (`@PlatformStepUpExempt()`).
 *
 * Refusals 1–3 are the same 404 any unknown path gets, so the surface does not confirm it
 * exists to someone who is not on the list. Refusal 4 is a 403 `reauthentication_required`:
 * by then the caller is a listed operator, and the screen needs to know to ask again.
 */

/** Port so the guard is testable without a database. The repository satisfies it. */
export interface PlatformAdminLookup {
  findAccount(userId: string, correlationId: string): Promise<PlatformAdminAccount | null>;
  findLiveStepUp(
    userId: string,
    sessionId: string,
    correlationId: string,
  ): Promise<PlatformStepUp | null>;
}

export const PLATFORM_ADMIN_LOOKUP = Symbol.for('tmanage.PlatformAdminLookup');
export const PLATFORM_ADMIN_ALLOWLIST = Symbol.for('tmanage.PlatformAdminAllowlist');

const STEP_UP_EXEMPT = Symbol('tmanage.route.platformStepUpExempt');

/** Marks the two routes a listed operator may call before stepping up. */
export const PlatformStepUpExempt = (): MethodDecorator => SetMetadata(STEP_UP_EXEMPT, true);

/** What the guard proved, for the handler. Held off the request object's shape on purpose. */
export interface PlatformAdminActor {
  readonly account: PlatformAdminAccount;
  readonly sessionId: string;
  readonly stepUp: PlatformStepUp | null;
}

const ACTORS = new WeakMap<object, PlatformAdminActor>();

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformAdminActor => {
    const actor = ACTORS.get(context.switchToHttp().getRequest<object>());
    if (!actor) throw new Error('CurrentPlatformAdmin used on a route without PlatformAdminGuard');
    return actor;
  },
);

function notFound(auditCode: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, auditCode);
}

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PLATFORM_ADMIN_ALLOWLIST) private readonly allowlist: readonly string[],
    @Inject(PLATFORM_ADMIN_LOOKUP) private readonly lookup: PlatformAdminLookup,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.allowlist.length === 0) throw notFound('platform_admin_disabled');

    const request = context.switchToHttp().getRequest<object>();
    const state = requireRequestState(request);
    const session = state.session;
    if (!session) {
      throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, 'no_session');
    }
    if (state.authScheme !== 'cookie') throw notFound('platform_admin_token_refused');

    const account = await this.lookup.findAccount(session.userId, state.correlationId);
    if (
      !account ||
      !account.emailVerified ||
      !isPlatformAdminEmail(this.allowlist, account.email)
    ) {
      throw notFound('platform_admin_not_listed');
    }

    const stepUp = await this.lookup.findLiveStepUp(
      session.userId,
      session.sessionId,
      state.correlationId,
    );
    const exempt = this.reflector.getAllAndOverride<boolean>(STEP_UP_EXEMPT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!exempt && !stepUp) {
      throw new ApiError(
        403,
        'reauthentication_required',
        account.mfaEnabled
          ? 'Confirm your password and two-step code to open Platform admin.'
          : 'Confirm your password to open Platform admin.',
        undefined,
        'platform_admin_step_up_required',
      );
    }

    ACTORS.set(request, { account, sessionId: session.sessionId, stepUp });
    return true;
  }
}
