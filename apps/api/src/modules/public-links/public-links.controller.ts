import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, Public, RequireCapability } from '../../common/http/decorators.js';
import {
  INTAKE_SUBMIT_LIMITS,
  PUBLIC_LINK_VIEW_LIMITS,
  Throttle,
} from '../rate-limits/throttle-policies.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import type {
  CreatedPublicLink,
  OutsiderLinkView,
  OutsiderMeta,
  PublicLinkView,
  PublicLinksService,
} from './public-links.service.js';

export const PUBLIC_LINKS_SERVICE = Symbol.for('tmanage.PublicLinksService');

/**
 * 56-07 — `/v1/organizations/:orgSlug/public-links`: create, list, revoke.
 *
 * The capability depends on the link's kind and is decided by the service against the loaded
 * target (approval → `deliverable.publish`, intake → `client_request.triage`, quote/share →
 * `project.manage`; the organization-wide list → `org.security.manage`). The route guard asks
 * only the coarse question every member can answer (`work.read`), the way `@RequireCapability`
 * is meant to be used before the object is known; the service's `authorize()` is authoritative.
 * NEVER for the AI connector: a public link hands an outsider access, which an AI never issues.
 */
@Controller('v1/organizations/:orgSlug/public-links')
export class PublicLinksController {
  constructor(@Inject(PUBLIC_LINKS_SERVICE) private readonly links: PublicLinksService) {}

  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<CreatedPublicLink> {
    return this.links.create(context, principal, body);
  }

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ): Promise<{ readonly links: readonly PublicLinkView[] }> {
    return { links: await this.links.list(context, principal, { targetType, targetId }) };
  }

  @Delete(':linkId')
  @RequireCapability('work.read')
  @HttpCode(204)
  async revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    await this.links.revoke(context, principal, linkId);
  }
}

interface OutsiderRequest {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}
interface HeaderReply {
  header(name: string, value: string): unknown;
}

/**
 * Views: 30 a minute per IP (spec STRIDE "I"). Code and decision: 10 a minute, 60 an hour per IP
 * and token. Both fail closed when the bucket store is down.
 */
const LINK_WRITE_LIMITS: ThrottleLimits = { ...INTAKE_SUBMIT_LIMITS, perMinute: 10, perHour: 60 };
const LINK_VIEW_LIMITS: ThrottleLimits = { ...PUBLIC_LINK_VIEW_LIMITS, perMinute: 30 };

/**
 * 56-07 — the outsider's three routes. No session, `@Public()`, each with a named `@Throttle`;
 * never cached, never indexed, never sent on as a referrer. An unknown, malformed, or another
 * shape of token is the same 404 body as a missing one.
 */
@Controller('v1/public/links/:token')
export class PublicLinkAccessController {
  constructor(@Inject(PUBLIC_LINKS_SERVICE) private readonly links: PublicLinksService) {}

  @Get()
  @Public()
  @Throttle('public_link_view', LINK_VIEW_LIMITS)
  async open(
    @Param('token') token: string,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<OutsiderLinkView> {
    privateHeaders(reply);
    return this.links.open(token, meta(request));
  }

  @Post('code')
  @Public()
  @HttpCode(202)
  @Throttle('public_link_code', LINK_WRITE_LIMITS)
  async code(
    @Param('token') token: string,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ): Promise<{ readonly expiresInSeconds: number }> {
    privateHeaders(reply);
    return this.links.sendCode(token, meta(request));
  }

  @Post('decision')
  @Public()
  @HttpCode(200)
  @Throttle('public_link_decision', LINK_WRITE_LIMITS)
  async decision(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() request: OutsiderRequest,
    @Res({ passthrough: true }) reply: HeaderReply,
  ) {
    privateHeaders(reply);
    return this.links.decide(token, body, meta(request));
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
