import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError, MESSAGES } from '../errors.js';
import { IS_PUBLIC } from '../decorators.js';
import { CSRF_HEADER, isSafeMethod, verifyCsrfToken } from '../csrf.js';
import { isBoundTokenScheme, requireRequestState } from '../request-state.js';
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
 *
 * ## Two more refusals this guard owns (security audit run 1, wave 9)
 *
 * **F01 - bound tokens never reach the identity surface.** A personal access token or an AI
 * grant is a key to one organization for a script or an AI app. Every non-public route of the
 * `v1/auth` controllers (password set, reauth, factors, recovery codes, security activity) and of
 * `v1/sessions` (the device list and every revocation) is about the *person*, and an org-bound
 * token acting there escapes its binding - setting a first password on a Google-only account
 * turned a token into a full cookie session. So a bound scheme there is refused with **403
 * `forbidden`** (audit code `session_required_for_credentials`), on every method, before the CSRF
 * skip below. Matched on the controller's declared path, never on the request URL.
 *
 * **F43 - login CSRF.** The public routes that *start a session* are skipped above because there
 * is no session to bind a token to, which left them open to a cross-site form that signs the
 * victim into the attacker's account. They now need a same-origin request: an `Origin` that is
 * one of the configured web/API origins, or - with no `Origin` - a `Sec-Fetch-Site` of
 * `same-origin` or `none`. A request with neither header is not a browser and is admitted. The
 * machine-client OAuth routes (`/oauth/token`, `/oauth/revoke`, `/oauth/register`) are not on the
 * list and stay open to any origin.
 */

/** Nest's own route-path metadata key (`@nestjs/common/constants` PATH_METADATA). */
const PATH_METADATA = 'path';

/** The controller base paths whose non-public routes a bound token may never reach (F01). */
const IDENTITY_SURFACE_BASE_PATHS: readonly string[] = ['v1/auth', 'v1/sessions'];

/**
 * F43. The `@Public()` POST routes that establish a session, as `controller/handler` paths
 * exactly as the controllers declare them.
 */
export const SESSION_ESTABLISHING_ROUTES: ReadonlySet<string> = new Set([
  'v1/auth/password',
  'v1/auth/mfa',
  'v1/auth/recovery-code',
  'v1/auth/google/mfa',
  'v1/public/sign-up',
  'v1/invitations/registrations',
  'public/setup',
  'v1/dev/sessions',
]);

/** Fetch-metadata values a same-origin page (or the user typing a URL) produces. */
const SAME_ORIGIN_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

function declaredPath(value: unknown): string {
  const raw = typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
  return typeof raw === 'string' ? raw.replace(/^\/+|\/+$/g, '') : '';
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

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

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      // F43: a public POST that starts a session must come from our own pages.
      if (request.method.toUpperCase() === 'POST') {
        const route = this.routeOf(context);
        if (route !== undefined && SESSION_ESTABLISHING_ROUTES.has(route.full)) {
          this.requireSameOrigin(request.headers);
        }
      }
      return true;
    }

    const state = requireRequestState(request);

    // F01: the identity surface is for a cookie session only, on every method.
    if (isBoundTokenScheme(state.authScheme)) {
      const route = this.routeOf(context);
      if (route !== undefined && IDENTITY_SURFACE_BASE_PATHS.includes(route.base)) {
        throw new ApiError(
          403,
          'forbidden',
          MESSAGES.forbidden,
          undefined,
          'session_required_for_credentials',
        );
      }
    }

    if (isSafeMethod(request.method)) return true;

    // A personal access token is not an ambient credential — a browser never attaches it to a
    // cross-site request the way it attaches a cookie — so CSRF does not apply (0202). The MCP
    // connector's internal grant (S6) is the same: it rides an in-process inject, never a browser.
    // The skip keys strictly off the server-set `authScheme`, which `SessionAuthGuard` sets to a
    // bound-token scheme only on its Bearer or internal-grant paths, and the Bearer path runs only
    // when there is no session cookie. A request carrying a cookie therefore never reaches this
    // skip, even if it also carries a Bearer header. The marker is produced by a guard, never read
    // off the request, which is why it is safe to trust here.
    if (isBoundTokenScheme(state.authScheme)) return true;

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

  /** The matched route as the controllers declare it, read from Nest's route metadata. */
  private routeOf(context: ExecutionContext): { base: string; full: string } | undefined {
    const handler = context.getHandler() as unknown;
    const controller = context.getClass() as unknown;
    if (typeof handler !== 'function' || typeof controller !== 'function') return undefined;
    const base = declaredPath(this.reflector.get<unknown>(PATH_METADATA, controller));
    const sub = declaredPath(this.reflector.get<unknown>(PATH_METADATA, handler));
    return { base, full: [base, sub].filter((part) => part !== '').join('/') };
  }

  /** F43. Refuse a cross-site request to a session-establishing route. */
  private requireSameOrigin(headers: Record<string, string | string[] | undefined>): void {
    const origin = headerOf(headers, 'origin');
    const fetchSite = headerOf(headers, 'sec-fetch-site');
    const allowed = new Set(
      [originOf(this.config.webPublicUrl), originOf(this.config.apiPublicUrl)].filter(
        (value): value is string => value !== undefined,
      ),
    );

    let admitted: boolean;
    if (origin !== undefined) {
      admitted =
        origin !== 'null' &&
        (allowed.size > 0
          ? allowed.has(origin)
          : fetchSite === undefined || fetchSite !== 'cross-site');
    } else {
      admitted = fetchSite === undefined || SAME_ORIGIN_FETCH_SITES.has(fetchSite);
    }
    if (!admitted) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'cross_site_sign_in');
    }
  }
}
