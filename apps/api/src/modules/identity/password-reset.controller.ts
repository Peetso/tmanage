import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { NoTenant, Public } from '../../common/http/decorators.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { PasswordResetService } from './password-reset.service.js';

/** Injection tokens, local to this slice as `first-owner.tokens.ts` is to setup. */
export const PASSWORD_RESET_SERVICE = Symbol.for('tmanage.PasswordResetService');
export const PASSWORD_RESET_ADMISSION = Symbol.for('tmanage.PasswordResetAdmission');

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

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
 *    is unknown, used, superseded or expired, or 422 with the password's problems.
 */
@Controller('v1/password-resets')
export class PasswordResetController {
  constructor(
    @Inject(PASSWORD_RESET_SERVICE) private readonly resets: PasswordResetService,
    @Inject(PASSWORD_RESET_ADMISSION) private readonly admit: RequestAdmission,
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
  ): Promise<void> {
    const state = requireRequestState(request);
    this.admitOrRefuse(request);
    await this.resets.complete(body?.token, body?.password, context(request, state.correlationId));
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
