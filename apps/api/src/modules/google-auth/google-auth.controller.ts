import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { Public } from '../../common/http/decorators.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { looksLikeInvitationToken } from '../identity/invitation-token.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import type { SessionService } from '../identity/session.service.js';
import type { GoogleAuthService, GoogleOutcome } from './google-auth.service.js';
import {
  authorizationUrl,
  GOOGLE_CALLBACK_PATH,
  GOOGLE_COOKIE_PATH,
  GOOGLE_FLOW_COOKIE,
  GOOGLE_FLOW_TTL_SECONDS,
  GOOGLE_MFA_COOKIE,
  IdTokenRejectedError,
  newFlow,
  openFlow,
  openPendingMfa,
  sealFlow,
  sealPendingMfa,
  stateMatches,
  verifyIdToken,
  type GoogleFlow,
  type GoogleIntent,
  type GoogleTransport,
} from './google-oidc.js';
import {
  GOOGLE_AUTH_ADMISSION,
  GOOGLE_AUTH_OPTIONS,
  GOOGLE_AUTH_SERVICE,
  GOOGLE_AUTH_SESSIONS,
  GOOGLE_TRANSPORT,
} from './google-auth.tokens.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

export interface GoogleAuthOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `WEB_PUBLIC_URL`; the redirect URI is `${webPublicUrl}/v1/auth/google/callback`. */
  readonly webPublicUrl: string;
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
}

/** Wire bodies (contracts-check pairs these with apps/web/src/lib/api/google-auth.ts). */
export interface GoogleAvailabilityView {
  readonly available: true;
  readonly signUp: boolean;
}

export interface GoogleStartView {
  readonly url: string;
}

export interface GooglePendingMfaView {
  readonly status: 'mfa_required';
  readonly challengeToken: string;
  readonly expiresAt: string;
  readonly factors: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
  }[];
  readonly returnTo: string;
}

interface StartBody {
  readonly intent?: unknown;
  readonly invitationToken?: unknown;
  readonly organizationName?: unknown;
}

const INTENTS: readonly GoogleIntent[] = ['sign-in', 'sign-up', 'invitation'];

/**
 * "Continue with Google". Registered only when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
 * are both set, so with either missing every route is the router's 404 and the web hides the
 * button.
 *
 * - `GET  /v1/auth/google` — `{available, signUp}`.
 * - `POST /v1/auth/google/start` — `{intent, invitationToken?, organizationName?}` → `{url}`;
 *   sets the signed flow cookie (state, nonce, PKCE verifier) bound to this browser.
 * - `GET  /v1/auth/google/callback` — Google's redirect. Verifies state against the cookie,
 *   exchanges the code (PKCE), verifies the ID token, applies the intent's rule, starts the
 *   session (or parks an MFA challenge in a cookie) and redirects to the web app. Every failure
 *   redirects with a short `google_error` code; nothing secret is put in a URL.
 * - `POST /v1/auth/google/mfa` — hands the parked challenge to the sign-in screen, once.
 */
@Controller('v1/auth/google')
export class GoogleAuthController {
  constructor(
    @Inject(GOOGLE_AUTH_SERVICE) private readonly service: GoogleAuthService,
    @Inject(GOOGLE_AUTH_SESSIONS) private readonly sessions: SessionService,
    @Inject(GOOGLE_TRANSPORT) private readonly transport: GoogleTransport,
    @Inject(GOOGLE_AUTH_OPTIONS) private readonly options: GoogleAuthOptions,
    @Inject(GOOGLE_AUTH_ADMISSION) private readonly admit: RequestAdmission,
  ) {}

  @Get()
  @Public()
  availability(): GoogleAvailabilityView {
    return { available: true, signUp: this.service.signupOpen };
  }

  @Post('start')
  @Public()
  @HttpCode(200)
  start(
    @Body() body: StartBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): GoogleStartView {
    if (!this.admit(request.ip ?? 'unknown')) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
    const intent = INTENTS.find((candidate) => candidate === body?.intent);
    if (!intent) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'intent', message: 'must be sign-in, sign-up or invitation' },
      ]);
    }
    if (intent === 'sign-up' && !this.service.signupOpen) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const invitationToken =
      typeof body?.invitationToken === 'string' && looksLikeInvitationToken(body.invitationToken)
        ? body.invitationToken
        : undefined;
    if (intent === 'invitation' && invitationToken === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'invitationToken', message: 'must be the invitation token' },
      ]);
    }
    const organizationName =
      intent === 'sign-up' && typeof body?.organizationName === 'string'
        ? body.organizationName.trim().slice(0, 190)
        : undefined;

    const flow = newFlow(intent, {
      ...(invitationToken === undefined ? {} : { invitationToken }),
      ...(organizationName ? { organizationName } : {}),
    });
    reply.header(
      'set-cookie',
      serializeCookie(GOOGLE_FLOW_COOKIE, sealFlow(flow, this.options.sessionSecret), {
        path: GOOGLE_COOKIE_PATH,
        maxAgeSeconds: GOOGLE_FLOW_TTL_SECONDS,
        // Lax, not Strict: Google's redirect back is a cross-site top-level GET.
        sameSite: 'Lax',
        secure: this.options.secureCookies,
      }),
    );
    return {
      url: authorizationUrl({
        clientId: this.options.clientId,
        redirectUri: this.redirectUri(),
        flow,
      }),
    };
  }

  @Get('callback')
  @Public()
  @Redirect('/sign-in', 302)
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<{ url: string; statusCode: number }> {
    const state = requireRequestState(request);
    const cookies: string[] = [this.expire(GOOGLE_FLOW_COOKIE)];
    const flow = openFlow(
      readCookie(headerOf(request, 'cookie'), GOOGLE_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    const context = {
      ip: request.ip ?? null,
      userAgent: headerOf(request, 'user-agent') ?? null,
      correlationId: state.correlationId,
    };
    const finish = (url: string) => {
      reply.header('set-cookie', cookies);
      return { url, statusCode: 302 };
    };

    // State first: without a cookie whose state matches, nothing else is looked at.
    if (!flow || !stateMatches(flow, query['state'])) {
      await this.service.record(context, null, 'failed', 'google_bad_state');
      return finish('/sign-in?google_error=state');
    }
    if (typeof query['code'] !== 'string' || query['code'] === '') {
      // The person pressed Cancel on Google's screen (error=access_denied), or a malformed call.
      return finish(errorPath(flow, 'cancelled'));
    }

    let outcome: GoogleOutcome;
    try {
      const { idToken } = await this.transport.exchangeCode({
        code: query['code'],
        clientId: this.options.clientId,
        clientSecret: this.options.clientSecret,
        redirectUri: this.redirectUri(),
        verifier: flow.verifier,
      });
      const claims = verifyIdToken({
        idToken,
        clientId: this.options.clientId,
        nonce: flow.nonce,
        keys: await this.transport.signingKeys(),
      });
      outcome = await this.service.complete(flow, claims, context);
    } catch (error) {
      if (error instanceof IdTokenRejectedError) {
        await this.service.record(context, null, 'failed', `google_${error.reason}`);
        return finish(
          errorPath(flow, error.reason === 'email_unverified' ? 'unverified' : 'token'),
        );
      }
      console.error(
        '[google-auth] callback failed',
        error instanceof Error ? error.name : 'unknown',
      );
      return finish(errorPath(flow, 'failed'));
    }

    if (outcome.kind === 'refused') return finish(errorPath(flow, outcome.reason));
    if (outcome.kind === 'mfa') {
      cookies.push(
        serializeCookie(
          GOOGLE_MFA_COOKIE,
          sealPendingMfa(outcome.pending, this.options.sessionSecret),
          {
            path: GOOGLE_COOKIE_PATH,
            maxAgeSeconds: 300,
            sameSite: 'Lax',
            secure: this.options.secureCookies,
          },
        ),
      );
      return finish('/sign-in?google=mfa');
    }

    const established = await this.sessions.start({
      userId: outcome.userId,
      userAgent: context.userAgent,
      correlationId: state.correlationId,
    });
    cookies.push(...established.cookies);
    return finish(outcome.returnTo);
  }

  /** The parked second-factor challenge, handed over once and then cleared. */
  @Post('mfa')
  @Public()
  @HttpCode(200)
  pendingMfa(
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): GooglePendingMfaView {
    const pending = openPendingMfa(
      readCookie(headerOf(request, 'cookie'), GOOGLE_MFA_COOKIE),
      this.options.sessionSecret,
    );
    reply.header('set-cookie', this.expire(GOOGLE_MFA_COOKIE));
    if (!pending) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { status: 'mfa_required', ...pending };
  }

  private redirectUri(): string {
    return `${this.options.webPublicUrl.replace(/\/+$/u, '')}${GOOGLE_CALLBACK_PATH}`;
  }

  private expire(name: string): string {
    return expireCookie(name, {
      path: GOOGLE_COOKIE_PATH,
      sameSite: 'Lax',
      secure: this.options.secureCookies,
    });
  }
}

function headerOf(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Back to the screen the person started from, with a short code the screen translates. */
export function errorPath(flow: GoogleFlow, code: string): string {
  const suffix = `google_error=${encodeURIComponent(code)}`;
  if (flow.intent === 'invitation' && flow.invitationToken) {
    return `/invitations/${encodeURIComponent(flow.invitationToken)}?${suffix}`;
  }
  return flow.intent === 'sign-up' ? `/sign-up?${suffix}` : `/sign-in?${suffix}`;
}
