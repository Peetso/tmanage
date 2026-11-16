import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiError } from '../../common/http/errors.js';
import { CurrentSession, NoTenant, Public } from '../../common/http/decorators.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { AuthenticatedSession } from './session.service.js';
import type {
  EmailConfirmationRequest,
  EmailConfirmationService,
} from './password-reset.service.js';
import { PASSWORD_RESET_ADMISSION } from './password-reset.controller.js';

export const EMAIL_CONFIRMATION_SERVICE = Symbol.for('tmanage.EmailConfirmationService');

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

/** Wire body of `POST /v1/email-confirmations` (web: lib/api/email-confirmation.ts). */
export interface EmailConfirmationRequestedView {
  readonly status: EmailConfirmationRequest;
}

/**
 * VERIFYMAIL — confirming the address of a password account.
 *
 *  - `POST /v1/email-confirmations` (signed in) → 202 `{status}`: mails a confirmation link to
 *    the caller's OWN address (`sent`), or says it is `already_confirmed`, or `not_sent` (over
 *    the hourly bound, or mail is off). Nothing in the body names an account.
 *  - `POST /v1/email-confirmations/completions` `{ token }` (public) → 204, or 404 for a link that
 *    is unknown, used, superseded or expired. It confirms the address only: no session, no
 *    password change, no sign-in. The page asks for a click first, so a mail scanner that
 *    fetches the link does not spend it.
 */
@Controller('v1/email-confirmations')
export class EmailConfirmationController {
  constructor(
    @Inject(EMAIL_CONFIRMATION_SERVICE) private readonly confirmations: EmailConfirmationService,
    @Inject(PASSWORD_RESET_ADMISSION) private readonly admit: RequestAdmission,
  ) {}

  @Post()
  @NoTenant()
  @HttpCode(202)
  async request(
    @CurrentSession() session: AuthenticatedSession,
    @Req() request: RequestLike,
  ): Promise<EmailConfirmationRequestedView> {
    const state = requireRequestState(request);
    this.admitOrRefuse(request);
    return {
      status: await this.confirmations.request(
        session.userId,
        context(request, state.correlationId),
      ),
    };
  }

  @Post('completions')
  @Public()
  @NoTenant()
  @HttpCode(204)
  async complete(
    @Req() request: RequestLike,
    @Body() body: { readonly token?: unknown },
  ): Promise<void> {
    const state = requireRequestState(request);
    this.admitOrRefuse(request);
    await this.confirmations.complete(body?.token, context(request, state.correlationId));
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

function header(request: RequestLike, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function context(request: RequestLike, correlationId: string) {
  return { correlationId, ip: request.ip ?? null, userAgent: header(request, 'user-agent') };
}
