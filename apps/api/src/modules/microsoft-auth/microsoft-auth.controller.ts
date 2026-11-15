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
import { clientAddressKey, type RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { looksLikeInvitationToken } from '../identity/invitation-token.js';
import { expireCookie, readCookie, serializeCookie } from '../identity/session-token.js';
import type { SessionService } from '../identity/session.service.js';
import type {
  GoogleAvailabilityView,
  GooglePendingMfaView,
  GoogleStartView,
} from '../google-auth/google-auth.controller.js';
import type { GoogleAuthService, GoogleOutcome } from '../google-auth/google-auth.service.js';
import {
  GOOGLE_FLOW_TTL_SECONDS,
  IdTokenRejectedError,
  newFlow,
  openFlow,
  openPendingMfa,
  sealFlow,
  sealPendingMfa,
  stateMatches,
  type GoogleFlow,
  type GoogleIntent,
} from '../google-auth/google-oidc.js';
import {
  authorizationUrl,
  MICROSOFT_CALLBACK_PATH,
  MICROSOFT_COOKIE_PATH,
  MICROSOFT_FLOW_COOKIE,
  MICROSOFT_FLOW_PURPOSE,
  MICROSOFT_MFA_COOKIE,
  MICROSOFT_MFA_PURPOSE,
  verifyMicrosoftIdToken,
  type MicrosoftSignInConfig,
  type MicrosoftTransport,
} from './microsoft-oidc.js';
import {
  MICROSOFT_AUTH_ADMISSION,
  MICROSOFT_AUTH_OPTIONS,
  MICROSOFT_AUTH_SERVICE,
  MICROSOFT_AUTH_SESSIONS,
  MICROSOFT_TRANSPORT,
} from './microsoft-auth.tokens.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

export interface MicrosoftAuthOptions {
  readonly config: MicrosoftSignInConfig;
  /** `WEB_PUBLIC_URL`; the redirect URI is `${webPublicUrl}/v1/auth/microsoft/callback`. */
  readonly webPublicUrl: string;
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
}

interface StartBody {
  readonly intent?: unknown;
  readonly invitationToken?: unknown;
  readonly organizationName?: unknown;
}

const INTENTS: readonly GoogleIntent[] = ['sign-in', 'sign-up', 'invitation'];

/**
 * "Continue with Microsoft" (51-05), the same four routes as "Continue with Google" under
 * `/v1/auth/microsoft`, with the same wire bodies. Registered only when
 * `MICROSOFT_SIGNIN_CLIENT_ID` and `MICROSOFT_SIGNIN_CLIENT_SECRET` are both set; otherwise
 * every route is the router's 404 and the web hides the button. Failures redirect with a short
 * `microsoft_error` code; nothing secret is put in a URL.
 */
@Controller('v1/auth/microsoft')
export class MicrosoftAuthController {
  constructor(
    @Inject(MICROSOFT_AUTH_SERVICE) private readonly service: GoogleAuthService,
    @Inject(MICROSOFT_AUTH_SESSIONS) private readonly sessions: SessionService,
    @Inject(MICROSOFT_TRANSPORT) private readonly transport: MicrosoftTransport,
    @Inject(MICROSOFT_AUTH_OPTIONS) private readonly options: MicrosoftAuthOptions,
    @Inject(MICROSOFT_AUTH_ADMISSION) private readonly admit: RequestAdmission,
  ) {}

  @Get()
  @Public()
  async availability(@Req() request: RequestLike): Promise<GoogleAvailabilityView> {
    const correlationId = requireRequestState(request).correlationId;
    return { available: true, signUp: await this.service.isSignupOpen(correlationId) };
  }

  @Post('start')
  @Public()
  @HttpCode(200)
  async start(
    @Body() body: StartBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<GoogleStartView> {
    if (!this.admit(clientAddressKey(request.ip))) {
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
    if (
      intent === 'sign-up' &&
      !(await this.service.isSignupOpen(requireRequestState(request).correlationId))
    ) {
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
      serializeCookie(
        MICROSOFT_FLOW_COOKIE,
        sealFlow(flow, this.options.sessionSecret, MICROSOFT_FLOW_PURPOSE),
        {
          path: MICROSOFT_COOKIE_PATH,
          maxAgeSeconds: GOOGLE_FLOW_TTL_SECONDS,
          // Lax, not Strict: Microsoft's redirect back is a cross-site top-level GET.
          sameSite: 'Lax',
          secure: this.options.secureCookies,
        },
      ),
    );
    return {
      url: authorizationUrl({ config: this.options.config, redirectUri: this.redirectUri(), flow }),
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
    const cookies: string[] = [this.expire(MICROSOFT_FLOW_COOKIE)];
    const flow = openFlow(
      readCookie(headerOf(request, 'cookie'), MICROSOFT_FLOW_COOKIE),
      this.options.sessionSecret,
      undefined,
      MICROSOFT_FLOW_PURPOSE,
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
      await this.service.record(context, null, 'failed', 'microsoft_bad_state');
      return finish('/sign-in?microsoft_error=state');
    }
    if (typeof query['code'] !== 'string' || query['code'] === '') {
      // Cancel on Microsoft's screen (error=access_denied), or a malformed call.
      return finish(microsoftErrorPath(flow, 'cancelled'));
    }

    let outcome: GoogleOutcome;
    try {
      const { idToken } = await this.transport.exchangeCode({
        code: query['code'],
        config: this.options.config,
        redirectUri: this.redirectUri(),
        verifier: flow.verifier,
      });
      const claims = verifyMicrosoftIdToken({
        idToken,
        config: this.options.config,
        nonce: flow.nonce,
        keys: await this.transport.signingKeys(this.options.config),
      });
      outcome = await this.service.complete(flow, claims, context);
    } catch (error) {
      if (error instanceof IdTokenRejectedError) {
        await this.service.record(context, null, 'failed', `microsoft_${error.reason}`);
        return finish(
          microsoftErrorPath(flow, error.reason === 'email_unverified' ? 'unverified' : 'token'),
        );
      }
      console.error(
        '[microsoft-auth] callback failed',
        error instanceof Error ? error.name : 'unknown',
      );
      return finish(microsoftErrorPath(flow, 'failed'));
    }

    if (outcome.kind === 'refused') return finish(microsoftErrorPath(flow, outcome.reason));
    if (outcome.kind === 'mfa') {
      cookies.push(
        serializeCookie(
          MICROSOFT_MFA_COOKIE,
          sealPendingMfa(outcome.pending, this.options.sessionSecret, MICROSOFT_MFA_PURPOSE),
          {
            path: MICROSOFT_COOKIE_PATH,
            maxAgeSeconds: 300,
            sameSite: 'Lax',
            secure: this.options.secureCookies,
          },
        ),
      );
      return finish('/sign-in?microsoft=mfa');
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
      readCookie(headerOf(request, 'cookie'), MICROSOFT_MFA_COOKIE),
      this.options.sessionSecret,
      MICROSOFT_MFA_PURPOSE,
    );
    reply.header('set-cookie', this.expire(MICROSOFT_MFA_COOKIE));
    if (!pending) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { status: 'mfa_required', ...pending };
  }

  private redirectUri(): string {
    return `${this.options.webPublicUrl.replace(/\/+$/u, '')}${MICROSOFT_CALLBACK_PATH}`;
  }

  private expire(name: string): string {
    return expireCookie(name, {
      path: MICROSOFT_COOKIE_PATH,
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
export function microsoftErrorPath(flow: GoogleFlow, code: string): string {
  const suffix = `microsoft_error=${encodeURIComponent(code)}`;
  if (flow.intent === 'invitation' && flow.invitationToken) {
    return `/invitations/${encodeURIComponent(flow.invitationToken)}?${suffix}`;
  }
  return flow.intent === 'sign-up' ? `/sign-up?${suffix}` : `/sign-in?${suffix}`;
}
