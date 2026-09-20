import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../errors.js';
import { IS_PUBLIC } from '../decorators.js';
import { CSRF_HEADER, isSafeMethod, verifyCsrfToken } from '../csrf.js';
import { requireRequestState } from '../request-state.js';
import { API_CONFIG, AUTHENTICATION_EVENT_RECORDER } from '../tokens.js';
import type { ApiConfig } from '../api-config.js';
import { GUARD_REFUSAL_ACTIONS, GUARD_REFUSAL_REASONS } from '../authentication-event-recorder.js';
import type { AuthenticationEventRecorder } from '../authentication-event-recorder.js';

/**
 * CSRF for cookie-authenticated mutations — `04-SECURITY-PRIVACY` §3, SEC-03.
 *
 * Runs immediately after `SessionAuthGuard`, and the order is required rather than tidy: the
 * token is bound to the session id (ADR-0004), so there is nothing to verify against until
 * step 1 has established which session this is.
 *
 * ## What is checked, and what is deliberately not
 *
 * Unsafe methods only — the safe set is the allowlist, so an unfamiliar method is guarded by
 * default rather than exempt. Public routes are skipped because a route reached without a
 * session has no session to bind a token to.
 *
 * **The refresh route is not checked here.** It carries no access cookie, so its session id is
 * unknown until the refresh token has been looked up. Verification therefore happens inside
 * `SessionService.refresh()`, at the point the session id first exists and before the rotation
 * commits. That is a real seam, not an exemption: `refresh()` refuses a bad token with the
 * same generic message as every other refresh failure, and the database suite proves it.
 * The route reaches this guard as `@Public()`, which is why the skip above covers it.
 *
 * ## The header, not a form field
 *
 * The token must arrive in `X-CSRF-Token`. A cross-origin form post cannot set a custom
 * header — that is the mechanism — and a `simple` cross-origin request carrying one is
 * preflighted, which CORS then refuses.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AUTHENTICATION_EVENT_RECORDER)
    private readonly events: AuthenticationEventRecorder,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      readonly method: string;
      readonly ip?: string;
      readonly headers: Record<string, string | string[] | undefined>;
    }>();

    if (isSafeMethod(request.method)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const state = requireRequestState(request);
    const session = state.session;
    if (!session) {
      // Unreachable through the registered pipeline — a non-public route has already been
      // through `SessionAuthGuard`. Refusing rather than assuming keeps the guard correct if
      // it is ever registered on its own.
      throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, 'no_session');
    }

    const presented = request.headers[CSRF_HEADER];
    const token = typeof presented === 'string' ? presented : undefined;

    if (!verifyCsrfToken(token, session.sessionId, this.config.csrfSecret)) {
      // Record the denied mutation before refusing — status defect 4. Best-effort by the seam's
      // contract, so the 403 below keeps its status, body and timing whether or not the row is
      // written. The precise cause (`csrf_token_mismatch` / `csrf_token_absent`) still travels
      // to the log on `auditCode`; the table carries only the fixed `csrf_failed` reason. The
      // `try` is defence in depth: the refusal is the control and no recorder may take its place.
      try {
        const userAgent = request.headers['user-agent'];
        this.events.recordGuardRefusal({
          action: GUARD_REFUSAL_ACTIONS.csrf,
          reason: GUARD_REFUSAL_REASONS.csrfFailed,
          ip: request.ip ?? null,
          userAgent: typeof userAgent === 'string' ? userAgent : null,
          correlationId: state.correlationId,
        });
      } catch {
        // A recording failure is never the caller's problem; the 403 stands.
      }
      throw new ApiError(
        403,
        'csrf_failed',
        MESSAGES.csrfFailed,
        undefined,
        token ? 'csrf_token_mismatch' : 'csrf_token_absent',
      );
    }

    return true;
  }
}
