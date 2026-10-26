import { Body, Controller, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import type { ApiConfig } from '../../common/http/api-config.js';
import { ApiError } from '../../common/http/errors.js';
import { NoTenant, Public } from '../../common/http/decorators.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import type { PasswordResetService } from './password-reset.service.js';
import {
  newResetSignInGrant,
  RESET_SIGN_IN_GRANT_COOKIE,
  RESET_SIGN_IN_GRANT_PATH,
  RESET_SIGN_IN_GRANT_TTL_SECONDS,
  sealResetSignInGrant,
} from './reset-sign-in-grant.js';
import { serializeCookie } from './session-token.js';

/** Injection tokens, local to this slice as `first-owner.tokens.ts` is to setup. */
export const PASSWORD_RESET_SERVICE = Symbol.for('tmanage.PasswordResetService');
export const PASSWORD_RESET_ADMISSION = Symbol.for('tmanage.PasswordResetAdmission');

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface ReplyLike {
  header(name: string, value: string | readonly string[]): unknown;
}

/** The one setting the reset sign-in grant cookie needs (N01, wave 11): the sealing key. */
export type PasswordResetCookieConfig = Pick<ApiConfig, 'sessionSecret'>;

/** Wire body of a reset request — the same whatever the address (web: lib/api/password-reset.ts). */
export interface PasswordResetRequestedView {
  readonly status: 'requested';
}

/**
 * ID-05 recovery over HTTP (ACC-02). Both routes are `@Public()` and `@NoTenant()`: the person
 * is locked out, so there is no session and no organization. Both are rate-limited per address
 * before anything else — one sends mail, the other hashes a password.
 *
 *  - `POST /v1/password-resets` `{ email }` → 202 `{status:'requested'}`, always.
 *  - `POST /v1/password-resets/completions` `{ token, password }` → 204, or 404 for a link that
 *    is unknown, used, superseded or expired, or 422 with the password's problems. A 204 also
 *    sets the reset sign-in grant (N01, wave 11): an `HttpOnly`, `Secure`, `SameSite=Lax` cookie
 *    scoped to `POST /v1/auth/password` for 900 s, never in the body or the URL. It lets the
 *    holder's next sign-in with the new password through a lockout window a guesser re-filled.
 */
@Controller('v1/password-resets')
export class PasswordResetController {
  constructor(
    @Inject(PASSWORD_RESET_SERVICE) private readonly resets: PasswordResetService,
    @Inject(PASSWORD_RESET_ADMISSION) private readonly admit: RequestAdmission,
    /**
     * Optional so a suite that builds this controller bare still boots; with no config no grant
     * is issued, which is the pre-N01 behaviour (fail closed: the lockout stays as strict).
     */
    @Optional()
    @Inject(API_CONFIG)
    private readonly config?: PasswordResetCookieConfig,
  ) {}

  @Post()
  @Public()
  @NoTenant()
  @HttpCode(202)
  async request(
    @Req() request: RequestLike,
    @Body() body: { readonly email?: unknown },
  ): Promise<PasswordResetRequestedView> {
    const state = requireRequestState(request);
    this.admitOrRefuse(request);
    // The delivery is deliberately not awaited: the answer must not wait on, or vary with,
    // whether a mail was composed for this address.
    await this.resets.request(body?.email, context(request, state.correlationId));
    return { status: 'requested' };
  }

  @Post('completions')
  @Public()
  @NoTenant()
  @HttpCode(204)
  async complete(
    @Req() request: RequestLike,
    @Body() body: { readonly token?: unknown; readonly password?: unknown },
    @Res({ passthrough: true }) reply: ReplyLike,
  ): Promise<void> {
    const state = requireRequestState(request);
    this.admitOrRefuse(request);
    const done = await this.resets.complete(
      body?.token,
      body?.password,
      context(request, state.correlationId),
    );
    if (done.passwordSetAt === null || !this.config?.sessionSecret) return;
    reply.header(
      'set-cookie',
      serializeCookie(
        RESET_SIGN_IN_GRANT_COOKIE,
        sealResetSignInGrant(
          newResetSignInGrant({ userId: done.userId, passwordSetAt: done.passwordSetAt }),
          this.config.sessionSecret,
        ),
        {
          path: RESET_SIGN_IN_GRANT_PATH,
          maxAgeSeconds: RESET_SIGN_IN_GRANT_TTL_SECONDS,
          // `Lax`: the recover page and the sign-in form are same-site; a cross-site POST to the
          // sign-in route never carries it.
          sameSite: 'Lax',
          // Secure always: plain-HTTP local development simply gets no grant, which is the
          // stricter direction.
          secure: true,
        },
      ),
    );
  }

  private admitOrRefuse(request: RequestLike): void {
    if (!this.admit(request.ip ?? 'unknown')) {
      throw new ApiError(
        429,
        'rate_limited',
        'Too many attempts. Wait a few minutes and try again.',
      );
    }
  }
}

function context(request: RequestLike, correlationId: string) {
  const userAgent = request.headers['user-agent'];
  return {
    correlationId,
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}
