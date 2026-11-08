import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { Public } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { SessionService } from '../identity/session.service.js';
import { readCookie } from '../identity/session-token.js';
import { assertSignInOpen } from '../platform/maintenance.controller.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type {
  MagicLinkPreview,
  OutsiderMeta,
  PortalSignInService,
  ProvedSignIn,
} from './portal-sign-in.service.js';

export const PORTAL_SIGN_IN_SERVICE = Symbol.for('tmanage.PortalSignInService');
export const PORTAL_SIGN_IN_SESSIONS = Symbol.for('tmanage.PortalSignInSessions');

interface OutsiderRequest {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}
interface HeaderReply {
  header(name: string, value: string | readonly string[]): unknown;
}

/** Asking for a link mails someone: 5 a minute, 20 an hour per IP, closed when the store is down. */
const REQUEST_LIMITS: ThrottleLimits = {
  perMinute: 5,
  perHour: 20,
  key: 'ip',
  onStoreError: 'closed',
};
/** Opening, cancelling and code guesses: 10 a minute, 60 an hour per IP. */
const LINK_LIMITS: ThrottleLimits = {
  perMinute: 10,
  perHour: 60,
  key: 'ip',
  onStoreError: 'closed',
};
const VIEW_LIMITS: ThrottleLimits = {
  perMinute: 30,
  perHour: 600,
  key: 'ip',
  onStoreError: 'closed',
};

export interface PortalSignedInView {
  readonly status: 'authenticated';
  readonly csrfToken: string;
  readonly expiresAt: string;
}

/**
 * 55-14 — `/v1/public/portal-sign-in`: the client portal's e-mail-link sign-in. No session in,
 * `@Public()`, a named throttle on every route; never cached, indexed or sent on as a referrer.
 * The two routes that start a session are same-origin only (F43, `csrf.guard.ts`) and refuse
 * while another session is signed in on this browser (sign out first; 56 §5.15 "no merge").
 */
@Controller('v1/public/portal-sign-in')
export class PortalSignInController {
  constructor(
    @Inject(PORTAL_SIGN_IN_SERVICE) private readonly service: PortalSignInService,
    @Inject(PORTAL_SIGN_IN_SESSIONS) private readonly sessions: SessionService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
  ) {}

  @Post()
  @Public()
  @HttpCode(202)
  @Throttle('portal_sign_in_request', REQUEST_LIMITS)
  async request(
    @Body() body: unknown,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<{ readonly status: 'sent' }> {
    privateHeaders(reply);
    return this.service.request(body, meta(request));
  }

  @Post('code')
  @Public()
  @HttpCode(200)
  @Throttle('portal_sign_in_code', LINK_LIMITS)
  async code(
    @Body() body: unknown,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<PortalSignedInView> {
    privateHeaders(reply);
    await this.refuseWhenSignedIn(request);
    return this.establish(await this.service.verifyCode(body, meta(request)), request, reply);
  }

  @Get('links/:token')
  @Public()
  @Throttle('portal_sign_in_view', VIEW_LIMITS)
  async preview(
    @Param('token') token: string,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<MagicLinkPreview> {
    privateHeaders(reply);
    return this.service.preview(token, meta(request));
  }

  @Post('links/:token/consume')
  @Public()
  @HttpCode(200)
  @Throttle('portal_sign_in_consume', LINK_LIMITS)
  async consume(
    @Param('token') token: string,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<PortalSignedInView> {
    privateHeaders(reply);
    await this.refuseWhenSignedIn(request);
    return this.establish(await this.service.consume(token, meta(request)), request, reply);
  }

  @Post('links/:token/not-you')
  @Public()
  @HttpCode(204)
  @Throttle('portal_sign_in_not_you', LINK_LIMITS)
  async notYou(
    @Param('token') token: string,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<void> {
    privateHeaders(reply);
    await this.service.notYou(token, meta(request));
  }

  /** A live session on this browser is refused 409 `signed_in`, before the link is spent. */
  private async refuseWhenSignedIn(request: OutsiderRequest): Promise<void> {
    const raw = request.headers['cookie'];
    const accessToken = readCookie(
      Array.isArray(raw) ? raw.join('; ') : raw,
      this.config.cookieName,
    );
    if (accessToken === undefined) return;
    try {
      await this.sessions.authenticate({ accessToken, correlationId: 'portal-sign-in-check' });
    } catch {
      return; // an expired or unknown cookie is not a session
    }
    throw new ApiError(409, 'conflict', 'You are already signed in. Sign out first.', [
      { field: 'session', message: 'signed_in' },
    ]);
  }

  private async establish(
    proved: ProvedSignIn,
    request: OutsiderRequest,
    reply: HeaderReply,
  ): Promise<PortalSignedInView> {
    await assertSignInOpen(this.database, this.config.platformAdminEmails ?? [], {
      userId: proved.userId,
      acceptLanguage: request.headers['accept-language'],
      correlationId: proved.correlationId,
    });
    const agent = request.headers['user-agent'];
    const established = await this.sessions.start({
      userId: proved.userId,
      userAgent: typeof agent === 'string' ? agent : null,
      correlationId: proved.correlationId,
      ip: request.ip ?? null,
      linkSignInEvent: true,
    });
    reply.header('set-cookie', established.cookies);
    return {
      status: 'authenticated',
      csrfToken: established.csrfToken,
      expiresAt: established.expiresAt.toISOString(),
    };
  }
}

function privateHeaders(reply: HeaderReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('x-robots-tag', 'noindex, nofollow');
  reply.header('referrer-policy', 'no-referrer');
}

function meta(request: OutsiderRequest): OutsiderMeta {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: Array.isArray(agent) ? agent[0] : agent };
}
