import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { CurrentSession, NoTenant, Public } from '../../common/http/decorators.js';
import { CSRF_HEADER } from '../../common/http/csrf.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { API_CONFIG, AUTHENTICATION_SERVICE, SESSION_SERVICE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { RefreshRejectedError } from './session.service.js';
import type {
  AuthenticatedSession,
  EstablishedSessionView,
  SessionService,
  SessionSummaryView,
} from './session.service.js';
import {
  ReauthenticationRequiredError,
  type AuthenticationService,
} from './authentication.service.js';
import { REAUTH_HEADER } from './authentication.controller.js';
import { notifyBrowserSessionEnded } from '../platform-admin/support/support-session.service.js';
import { readCookie } from './session-token.js';

/**
 * The session routes — `04-SECURITY-PRIVACY` §3's "device/session list", sign-out, and refresh.
 *
 * The controller touches no database (ADR-0001 layer 4, enforced by lint). It reads cookies,
 * calls `SessionService`, and writes what the service produced.
 *
 * Every route here is `@NoTenant()`: these are about the person, not about an organization, so
 * there is no `:orgSlug` to resolve and no capability to check. Refresh is additionally
 * `@Public()` — it authenticates with the refresh cookie rather than the access cookie, so
 * `SessionAuthGuard` has nothing to verify, and its CSRF check happens inside the service
 * where the session id first exists (ADR-0004).
 */

/** Minimal shapes, so the controller does not depend on Fastify's full types. */
interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  /** The abuse-controlled source address, for the security-log row a revocation writes. */
  readonly ip?: string;
}
/**
 * Only `header`. Every route below uses `@Res({ passthrough: true })`, so Nest still sends the
 * return value and applies `@HttpCode` — the reply is reached for exactly one reason, which is
 * that `Set-Cookie` cannot be expressed as a return value. Taking the full reply object and
 * calling `send()` on it would switch Nest into library-specific mode, where the interceptor
 * and the exception filter no longer shape the response.
 */
interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

interface DevelopmentSignInBody {
  readonly userId?: unknown;
}

@Controller('v1/sessions')
export class SessionController {
  constructor(
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    // `I-1`. The revoke routes run behind `requireReauth`, which lives on the authentication
    // service alongside the security-log path they record through; the controller reads the
    // `x-reauth-token` header and hands it across.
    @Inject(AUTHENTICATION_SERVICE) private readonly authentication: AuthenticationService,
  ) {}

  /**
   * Rotate the refresh token.
   *
   * `@Public()` because the access cookie is absent or expired by definition here — that is
   * what the caller is trying to fix. The refresh cookie is the credential, and it is
   * `SameSite=Strict` and scoped to this exact path, so it is not sent on any other request.
   */
  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<EstablishedSessionView> {
    const state = requireRequestState(request);
    const cookieHeader = request.headers['cookie'];
    const refreshToken = readCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      `${this.config.cookieName}_refresh`,
    );
    const csrfHeader = request.headers[CSRF_HEADER];

    try {
      const established = await this.sessions.refresh({
        refreshToken,
        csrfToken: typeof csrfHeader === 'string' ? csrfHeader : undefined,
        correlationId: state.correlationId,
      });
      reply.header('set-cookie', established.cookies);
      // The CSRF token is also in a readable cookie; returning it means a client that is not a
      // browser never has to parse `Set-Cookie` to use the API.
      return { csrfToken: established.csrfToken, expiresAt: established.expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof RefreshRejectedError) {
        // Every refresh failure clears the cookies. A client holding a token the server will
        // never accept again — replayed, revoked, expired — should stop presenting it, and
        // leaving it in place turns one refusal into a loop of them.
        reply.header('set-cookie', this.sessions.clearedCookies());
        throw new ApiError(401, 'unauthenticated', MESSAGES.unauthenticated, undefined, error.code);
      }
      throw error;
    }
  }

  /** Sign out of this session. Idempotent — a second call changes nothing. */
  @Delete('current')
  @NoTenant()
  @HttpCode(204)
  async signOut(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<void> {
    const state = requireRequestState(request);
    await this.sessions.revoke({
      sessionId: session.sessionId,
      reason: 'user_sign_out',
      correlationId: state.correlationId,
    });
    // SPEC §3.2: a platform admin's sign-out ends any Support session bound to this browser
    // session. Never throws (the sweeper and the banner read are the fallbacks).
    await notifyBrowserSessionEnded(session.userId, session.sessionId, state.correlationId);
    reply.header('set-cookie', this.sessions.clearedCookies());
  }

  /** The device/session list (04 §3). Carries no credential material of any kind. */
  @Get('current/devices')
  @NoTenant()
  async devices(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<{ readonly sessions: readonly SessionSummaryView[] }> {
    const state = requireRequestState(request);
    const rows = await this.sessions.listForUser({
      userId: session.userId,
      correlationId: state.correlationId,
    });
    // Project the repository's `Date` columns to the ISO strings the wire carries. This is the
    // same text `JSON.stringify` produces for a `Date` (it calls `toISOString`), so the response
    // bytes are unchanged; naming the projection is what lets `SessionSummaryView` — and the web
    // shape paired against it — describe the wire truthfully rather than the internal `Date` type.
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
        expiresAt: row.expiresAt.toISOString(),
      })),
    };
  }

  /**
   * `I-1`. Revoke every *other* session — the "revoke all" of `22-SCREEN-BY-SCREEN` §3. The
   * session making the request is kept; every other device this person holds is ended, and its
   * refresh cookie stops working with it.
   *
   * Behind `requireReauth` (the service verifies the `x-reauth-token` header), because ending
   * a person's other devices is credential-adjacent: a stolen access cookie must not be
   * enough. `CsrfGuard` is global and already covers this unsafe method.
   */
  @Delete()
  @NoTenant()
  @HttpCode(204)
  async revokeOthers(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<void> {
    const state = requireRequestState(request);
    try {
      await this.authentication.revokeOtherSessions({
        userId: session.userId,
        sessionId: session.sessionId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      throw error;
    }
  }

  /**
   * `I-1`. Revoke one named session — a device from the list, or this one.
   *
   * `DELETE current` is a static route and wins over this parameter in the router, so
   * sign-out still reaches {@link signOut} and this only ever sees a real session id. A
   * session that is not this person's, or does not exist, answers **404** exactly as
   * `DELETE /v1/auth/factors/:id` does, so the id cannot be probed. Behind `requireReauth`,
   * for the reason {@link revokeOthers} gives.
   */
  @Delete(':sessionId')
  @NoTenant()
  @HttpCode(204)
  async revokeOne(
    @CurrentSession() session: AuthenticatedSession,
    @Param('sessionId') sessionId: string,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<void> {
    const state = requireRequestState(request);
    let removed: boolean;
    try {
      removed = await this.authentication.revokeSession({
        userId: session.userId,
        sessionId: session.sessionId,
        targetSessionId: sessionId,
        reauthToken: this.reauthTokenOf(request),
        context: this.contextOf(request, state.correlationId),
      });
    } catch (error) {
      this.translateReauth(error);
      throw error;
    }
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    await notifyBrowserSessionEnded(session.userId, sessionId, state.correlationId);
    // Revoking your own current session from the device list is signing out of it: clear the
    // credentials the same way `DELETE current` does (same helper, one source of the cookie
    // attributes), so the browser stops believing it is signed in. Any other device: no cookies.
    if (sessionId === session.sessionId) {
      reply.header('set-cookie', this.sessions.clearedCookies());
    }
  }

  /** The `x-reauth-token` header, if one was sent. Absence is the service's decision to make. */
  private reauthTokenOf(request: RequestLike): string | undefined {
    const raw = request.headers[REAUTH_HEADER];
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  }

  /**
   * `D05`'s refusal, restated here because these routes gate on the same proof the enrolment
   * routes do: **403 `reauthentication_required`**, not 401 (the session is genuine) and not
   * the generic `forbidden` (the client's correct response is specific — ask for the password,
   * call `POST /v1/auth/reauth`, retry with the header). The precise reason goes to the log.
   */
  private translateReauth(error: unknown): void {
    if (error instanceof ReauthenticationRequiredError) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to make this change.',
        undefined,
        error.reason,
      );
    }
  }

  private contextOf(request: RequestLike, correlationId: string) {
    const userAgent = request.headers['user-agent'];
    return {
      correlationId,
      ip: request.ip ?? null,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
    };
  }
}

/**
 * The development-only sign-in route.
 *
 * ID-002 — passwords, passkeys, MFA, SSO — is not written, so nothing in this application
 * authenticates a person. `SessionService.start()` takes a `userId` that something else has
 * already proved, and this route is the honest placeholder for that something else: it takes
 * the `userId` on trust and says so in its name and its path.
 *
 * It is a **separate class** from `SessionController` so that it can be left out of the module
 * entirely in production (see `identity.module.ts`). A route that exists and returns 403 is
 * one edit away from existing and returning a session; a route that was never registered is
 * not reachable by any edit to a guard, a config value, or an environment variable.
 */
@Controller('v1/dev/sessions')
export class DevelopmentSignInController {
  constructor(@Inject(SESSION_SERVICE) private readonly sessions: SessionService) {}

  @Post()
  @Public()
  @HttpCode(201)
  async signIn(
    @Body() body: DevelopmentSignInBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<EstablishedSessionView> {
    const state = requireRequestState(request);
    const userId = typeof body?.userId === 'string' ? body.userId : undefined;
    if (!userId) {
      throw new ApiError(400, 'validation_failed', 'userId is required', [
        { field: 'userId', message: 'must be a string' },
      ]);
    }

    const userAgent = request.headers['user-agent'];
    const established = await this.sessions.start({
      userId,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      correlationId: state.correlationId,
    });

    reply.header('set-cookie', established.cookies);
    return { csrfToken: established.csrfToken, expiresAt: established.expiresAt.toISOString() };
  }
}
