import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../errors.js';
import { IS_PUBLIC } from '../decorators.js';
import { requireRequestState } from '../request-state.js';
import { API_CONFIG, AUTHENTICATION_EVENT_RECORDER, SESSION_SERVICE } from '../tokens.js';
import type { ApiConfig } from '../api-config.js';
import { GUARD_REFUSAL_ACTIONS, GUARD_REFUSAL_REASONS } from '../authentication-event-recorder.js';
import type { AuthenticationEventRecorder } from '../authentication-event-recorder.js';
import { SessionNotAuthenticatedError } from '../../../modules/identity/session.service.js';
import type { SessionService } from '../../../modules/identity/session.service.js';
import { readCookie } from '../../../modules/identity/session-token.js';

/**
 * Spec §3 step 1 — "authenticate the current session and validate revocation/cutoff".
 *
 * The guard is a thin adapter over `SessionService.authenticate()`, which already does the
 * work: verify the access token's HMAC, then **read the session row**, because 04 §3 requires
 * immediate server-side revocation and a token trusted on its signature alone stays valid
 * until it expires. Nothing about that decision is re-litigated here.
 *
 * What this layer adds is the translation, and the translation is where information leaks if
 * it is careless. `SessionNotAuthenticatedError` distinguishes eight causes — `no_cookie`,
 * `bad_signature`, `session_revoked`, `session_expired` and so on — and every one of them
 * becomes the same 401 with the same body. The cause travels to the log on `auditCode`.
 *
 * ## The refusal is now recorded — status defect 4
 *
 * Every one of those causes is a denied sensitive attempt (`04-SECURITY-PRIVACY` §4/§6,
 * `25 §12`), and until now none left a row. The refusal is recorded through
 * {@link AuthenticationEventRecorder} with the single safe reason `missing_session` — the fixed
 * cause travels to the log on `auditCode` as before, so nothing more specific needs to reach the
 * table. The record is best-effort by that seam's contract: it cannot change or delay the 401,
 * so a database outage costs an audit row, never the refusal.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AUTHENTICATION_EVENT_RECORDER)
    private readonly events: AuthenticationEventRecorder,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      readonly ip?: string;
      readonly headers: Record<string, string | string[] | undefined>;
    }>();
    const state = requireRequestState(request);

    const cookieHeader = request.headers['cookie'];
    const accessToken = readCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      this.config.cookieName,
    );

    try {
      state.session = await this.sessions.authenticate({
        accessToken,
        correlationId: state.correlationId,
      });
    } catch (error) {
      if (error instanceof SessionNotAuthenticatedError) {
        // Record the denied attempt before refusing. Best-effort by the seam's contract — it
        // returns immediately and never throws — so the 401 below is untouched in status, body
        // and timing whether or not the row is written. The `try` is defence in depth: the
        // refusal is the control and no recorder, however it misbehaves, may take its place.
        try {
          const userAgent = request.headers['user-agent'];
          this.events.recordGuardRefusal({
            action: GUARD_REFUSAL_ACTIONS.session,
            reason: GUARD_REFUSAL_REASONS.missingSession,
            ip: request.ip ?? null,
            userAgent: typeof userAgent === 'string' ? userAgent : null,
            correlationId: state.correlationId,
          });
        } catch {
          // A recording failure is never the caller's problem; the 401 stands.
        }
        throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, error.code);
      }
      throw error;
    }

    return true;
  }
}
