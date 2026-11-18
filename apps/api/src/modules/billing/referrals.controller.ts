import { Controller, Get, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { requireReferralOwner } from './referrals.rules.js';
import { ReferralsService } from './referrals.service.js';
import type { ReferralView } from './referrals.service.js';

/** Injection token for a hand-built service in tests. */
export const REFERRALS_SERVICE = 'REFERRALS_SERVICE';

/**
 * 57-08 REFERRAL — Settings › People › Invite agencies (Figma 724:39791 / 724:40204).
 *
 * Behind `org.manage` (owner and org admin), then the owner gate on every route: only the
 * workspace owner has an invite link ({@link requireReferralOwner}, 403 `referral:owner`). The
 * workspace is always the session's; nothing is read from the body. The list holds the agencies
 * that signed up (name + date) and never an address or an "invited" count.
 */
@Controller('v1/organizations/:orgSlug/referral')
export class ReferralsController {
  private readonly service: ReferralsService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() @Inject(REFERRALS_SERVICE) service?: ReferralsService,
  ) {
    this.service = service ?? new ReferralsService(database);
  }

  @Get()
  @RequireCapability('org.manage')
  async read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ReferralView> {
    requireReferralOwner(principal);
    return this.service.view(context);
  }

  /** Create the workspace's link on first use (idempotent; 200 with the page's state). */
  @Post('code')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async createCode(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ReferralView> {
    requireReferralOwner(principal);
    return this.service.ensureCode(context);
  }
}
