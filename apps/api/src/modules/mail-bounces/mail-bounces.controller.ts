import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MailBounceStatus, MailBouncesService } from './mail-bounces.service.js';

export const MAIL_BOUNCES_SERVICE = Symbol.for('tmanage.MailBouncesService');

/**
 * 56-26. An owner or admin checks and clears bounce suppressions in their own company:
 *
 * - `POST …/mail/bounces/status` — `{address}`: whether that address bounced here.
 * - `POST …/mail/bounces/clear` — `{address}`: lift the suppression; mail to it goes again.
 *
 * POST with the address in the body, so it is never in a URL or an access log. Behind
 * `org.security.manage` (Owner, Org Admin); the service authorizes again. Never an AI action
 * (`ai-actions/registry/never.ts`).
 */
@Controller('v1/organizations/:orgSlug/mail/bounces')
export class MailBouncesController {
  constructor(@Inject(MAIL_BOUNCES_SERVICE) private readonly bounces: MailBouncesService) {}

  @Post('status')
  @RequireCapability('org.security.manage')
  @HttpCode(200)
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<MailBounceStatus> {
    return this.bounces.status(context, principal, body);
  }

  @Post('clear')
  @RequireCapability('org.security.manage')
  @HttpCode(200)
  async clear(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<MailBounceStatus> {
    return this.bounces.clear(context, principal, body);
  }
}
