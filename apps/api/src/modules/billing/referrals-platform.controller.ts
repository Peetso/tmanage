import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { insertPlatformAudit } from '../platform-admin/platform-audit.service.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import { REFERRALS_SERVICE } from './referrals.controller.js';
import { parsePartnerName } from './referrals.rules.js';
import { ReferralsService } from './referrals.service.js';
import type { PlatformReferralsView } from './referrals.service.js';

/**
 * 57-08 REFERRAL — the Platform admin's partner (agency reseller) codes and their sign-up lists,
 * plus workspace invite-link totals by outcome (Growth page).
 *
 * - `GET  /v1/platform/referrals` behind `platform.activity.view`: read-only.
 * - `POST /v1/platform/referrals/partners` behind `platform.settings.edit`: a new partner code,
 *   with its platform audit row in the same transaction.
 */
@Controller('v1/platform/referrals')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformReferralsController {
  private readonly service: ReferralsService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() @Inject(REFERRALS_SERVICE) service?: ReferralsService,
  ) {
    this.service = service ?? new ReferralsService(database);
  }

  @Get()
  @RequirePlatformPermission('platform.activity.view')
  list(@Req() request: object): Promise<PlatformReferralsView> {
    return this.service.platformView(requireRequestState(request).correlationId);
  }

  @Post('partners')
  @RequirePlatformPermission('platform.settings.edit')
  @HttpCode(201)
  async createPartner(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: unknown,
    @Req() request: object,
  ): Promise<{ readonly id: string; readonly code: string }> {
    const name = parsePartnerName(body);
    const correlationId = requireRequestState(request).correlationId;
    return this.service.createPartner(name, actor.account.userId, correlationId, (tx, partner) =>
      insertPlatformAudit(tx, {
        actorUserId: actor.account.userId,
        actorEmail: actor.account.email,
        action: 'referral.partner.create',
        targetType: 'platform',
        targetId: partner.id,
        targetLabel: name,
        reason: null,
        correlationId,
        afterJson: JSON.stringify({ code: partner.code }),
      }),
    );
  }
}
