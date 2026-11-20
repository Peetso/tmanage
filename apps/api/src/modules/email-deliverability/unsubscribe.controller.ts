import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { verifyUnsubscribeToken } from '@tmanage/mail';
import { Public } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import type { EmailSuppressionWriter } from './email-suppressions.repository.js';

export const UNSUBSCRIBE_CONFIG = Symbol.for('tmanage.UnsubscribeConfig');
export const EMAIL_SUPPRESSION_WRITER = Symbol.for('tmanage.EmailSuppressionWriter');

export interface UnsubscribeConfig {
  /** HMAC key from `deriveUnsubscribeKey`; `null` = no server secret, the route refuses. */
  readonly key: Buffer | null;
  /** Where a browser that opened the link (GET) is sent: the web app, never a new screen. */
  readonly webPublicUrl: string;
}

interface RedirectReply {
  status(code: number): unknown;
  header(name: string, value: string): unknown;
}

/**
 * 51-11 — `POST /v1/public/email/unsubscribe?t=<token>`, the RFC 8058 one-click target the
 * `List-Unsubscribe` header names.
 *
 * `@Public()`: the mail client posts with no cookie, so there is no session to bind a CSRF token
 * to and the signed token is the whole authority. The token can do exactly one thing — stop
 * notification mail to the address it was minted for — so a leaked link harms nobody else. The
 * body (`List-Unsubscribe=One-Click`) is not read; the token is in the URL by the RFC's design and
 * holds an address hash, never the address. A bad token is one generic 400, the same for forged,
 * truncated or foreign tokens. The global durable throttle charges this route like every
 * `@Public()` one.
 *
 * `GET` never unsubscribes: link scanners and previewers fetch every URL in a mail, and a GET that
 * acted would unsubscribe people who never clicked. A person who opens the link in a browser is
 * sent to the web app (303). PERSONMAIL (ADR-0013): with a valid token, to the unsubscribe page
 * (`/unsubscribe/{token}`), which asks for one click and says plainly that sign-in, security and
 * account messages are still sent; without one (the footer's "Notification settings" link), to
 * the app, where notification settings live.
 */
@Controller('v1/public/email')
export class UnsubscribeController {
  constructor(
    @Inject(UNSUBSCRIBE_CONFIG) private readonly config: UnsubscribeConfig,
    @Inject(EMAIL_SUPPRESSION_WRITER) private readonly suppressions: EmailSuppressionWriter,
  ) {}

  @Post('unsubscribe')
  @Public()
  @HttpCode(200)
  async oneClick(
    @Query('t') token: unknown,
    @Req() request: object,
  ): Promise<{ readonly status: 'unsubscribed' }> {
    const hash = this.config.key === null ? null : verifyUnsubscribeToken(this.config.key, token);
    if (hash === null) {
      throw new ApiError(400, 'validation_failed', 'this unsubscribe link is not valid');
    }
    await this.suppressions.suppress(hash, requireRequestState(request).correlationId);
    return { status: 'unsubscribed' };
  }

  @Get('unsubscribe')
  @Public()
  opened(@Query('t') token: unknown, @Res({ passthrough: true }) reply: RedirectReply): void {
    const valid =
      this.config.key !== null &&
      typeof token === 'string' &&
      verifyUnsubscribeToken(this.config.key, token) !== null;
    // The token is verified before it is put in a path; it holds only [A-Za-z0-9._-].
    const path = valid ? `/unsubscribe/${encodeURIComponent(token)}` : '/';
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('location', new URL(path, this.config.webPublicUrl).toString());
    reply.status(303);
  }
}
