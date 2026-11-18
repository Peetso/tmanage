import { signupAttributionFromCookie, SIGNUP_ATTRIBUTION_COOKIE } from '@tmanage/domain';
import { Body, Controller, Get, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { Public } from '../../common/http/decorators.js';
import { clientAddressKey, type RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { SessionService } from '../identity/session.service.js';
import { readCookie } from '../identity/session-token.js';
import type { PublicSignupSwitch } from '../platform-admin/platform-settings.js';
import { PUBLIC_ABUSE_ASSESS } from '../public-abuse/public-abuse.guard.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import {
  ACCOUNT_EXISTS_SIGNUP_MESSAGE,
  normaliseSignupEmail,
  type PublicSignupAvailabilityView,
  type PublicSignupBody,
  type PublicSignupService,
  type PublicSignupView,
} from './public-signup.service.js';
import { SignupEmailTakenError } from './signup-accounts.repository.js';
import {
  PUBLIC_SIGNUP_ADMISSION,
  PUBLIC_SIGNUP_EMAIL_ADMISSION,
  PUBLIC_SIGNUP_SERVICE,
  PUBLIC_SIGNUP_SESSIONS,
  PUBLIC_SIGNUP_SWITCH,
} from './public-signup.tokens.js';

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

/**
 * ADTRACK. The landing page's `utm_*` values from the web proxy's first-party cookie, validated
 * again here: the cookie is client-held, so only what the shared schema accepts is kept.
 */
export function signupAttributionOf(request: RequestLike) {
  const header = request.headers['cookie'];
  return signupAttributionFromCookie(
    readCookie(typeof header === 'string' ? header : undefined, SIGNUP_ATTRIBUTION_COOKIE),
  );
}

const RATE_LIMITED = 'Too many attempts. Wait a few minutes and try again.';

/**
 * `GET /v1/public/sign-up` (is it open?) and `POST /v1/public/sign-up` (create account +
 * organization, signed in). Registered only while `PUBLIC_SIGNUP` is on; otherwise both 404.
 *
 * Order on POST: per-source limit, honeypot, per-address limit, the 52-21 abuse assessment, then
 * the service. A refused caller never reaches the password hash or the database.
 *
 * 52-21: a sign-up is never held — a person signing up must not wait on a review. It is refused
 * only when the assessment says `blocked` (a window: 429) or `spam` (score ≥ 70: the same opaque
 * 400 the honeypot gives). A form filled fast but carrying the JS proof scores 60 and goes on.
 */
@Controller('v1/public/sign-up')
export class PublicSignupController {
  constructor(
    @Inject(PUBLIC_SIGNUP_SERVICE) private readonly service: PublicSignupService,
    @Inject(PUBLIC_SIGNUP_SESSIONS) private readonly sessions: SessionService,
    @Inject(PUBLIC_SIGNUP_ADMISSION) private readonly admitSource: RequestAdmission,
    @Inject(PUBLIC_SIGNUP_EMAIL_ADMISSION) private readonly admitEmail: RequestAdmission,
    // Platform admin's switch (0206). Absent (a hand-built controller) means open — the module
    // is only registered while sign-up can be open at all.
    @Optional()
    @Inject(PUBLIC_SIGNUP_SWITCH)
    private readonly signupSwitch?: PublicSignupSwitch,
    // 52-21. Absent (a hand-built controller) means no assessment, the pre-52-21 behaviour.
    @Optional()
    @Inject(PUBLIC_ABUSE_ASSESS)
    private readonly assess?: AssessPublicWrite,
  ) {}

  @Get()
  @Public()
  async availability(@Req() request: RequestLike): Promise<PublicSignupAvailabilityView> {
    await this.requireOpen(request);
    return { available: true };
  }

  @Post()
  @Public()
  @HttpCode(201)
  async signUp(
    @Body() body: PublicSignupBody,
    @Req() request: RequestLike,
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<PublicSignupView> {
    const state = requireRequestState(request);
    await this.requireOpen(request);
    if (!this.admitSource(clientAddressKey(request.ip))) {
      throw new ApiError(429, 'rate_limited', RATE_LIMITED);
    }
    const honeypot = body?.website;
    if (
      typeof honeypot === 'string'
        ? honeypot.trim() !== ''
        : honeypot !== undefined && honeypot !== null
    ) {
      // Nothing a person can see asks for this field. No detail, so a bot learns nothing.
      throw new ApiError(
        400,
        'validation_failed',
        'That account cannot be created.',
        undefined,
        'signup_honeypot',
      );
    }
    const email = normaliseSignupEmail(body?.email);
    if (email !== undefined && !this.admitEmail(email)) {
      throw new ApiError(429, 'rate_limited', RATE_LIMITED);
    }
    const acceptLanguage = request.headers['accept-language'];
    const verdict = await this.assess?.({
      surface: 'signup',
      kind: 'signup',
      body: (body ?? {}) as Readonly<Record<string, unknown>>,
      email,
      texts: [
        typeof body?.displayName === 'string' ? body.displayName : undefined,
        typeof body?.organizationName === 'string' ? body.organizationName : undefined,
      ],
      ip: request.ip,
      acceptLanguage: typeof acceptLanguage === 'string' ? acceptLanguage : undefined,
      pageLocale: typeof body?.defaultLocale === 'string' ? body.defaultLocale : undefined,
      correlationId: state.correlationId,
    });
    if (verdict?.decision === 'blocked' && verdict.retryAfterSeconds !== undefined) {
      throw new ApiError(429, 'rate_limited', RATE_LIMITED);
    }
    if (verdict?.decision === 'blocked' || verdict?.decision === 'spam') {
      throw new ApiError(
        400,
        'validation_failed',
        'That account cannot be created.',
        undefined,
        'signup_abuse_refused',
      );
    }

    let result;
    try {
      result = await this.service.signUp(
        body ?? {},
        state.correlationId,
        signupAttributionOf(request),
      );
    } catch (error) {
      if (error instanceof SignupEmailTakenError) {
        throw new ApiError(
          409,
          'conflict',
          ACCOUNT_EXISTS_SIGNUP_MESSAGE,
          [{ field: 'email', message: 'account_exists' }],
          'signup_account_exists',
        );
      }
      throw error;
    }

    const userAgent = request.headers['user-agent'];
    const established = await this.sessions.start({
      userId: result.userId,
      userAgent: typeof userAgent === 'string' ? userAgent : null,
      correlationId: state.correlationId,
    });
    reply.header('set-cookie', established.cookies);
    return {
      status: 'authenticated',
      csrfToken: established.csrfToken,
      expiresAt: established.expiresAt.toISOString(),
      organizationSlug: result.slug,
      planId: result.planId ?? null,
    };
  }

  /** Closed is the same 404 the unregistered routes give, so the two states look alike. */
  private async requireOpen(request: RequestLike): Promise<void> {
    if (this.signupSwitch === undefined) return;
    const open = await this.signupSwitch.isOpen(requireRequestState(request).correlationId);
    if (!open) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'public_signup_closed');
    }
  }
}
