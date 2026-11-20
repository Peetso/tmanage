import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import type { AiCreditsView, AiPackRequestView, AiPacksService } from './ai-packs.service.js';

/** Slice-private token (the plan-usage posture), so `tokens.ts` stays untouched. */
export const AI_PACKS_SERVICE = Symbol.for('tmanage.AiPacksService');

/**
 * `…/organizations/:orgSlug/ai/credits` — 62-07 (plan 62 §5). The workspace's AI credits this
 * month and the owner's request for a credit pack while TManage AI is in testing.
 *
 * The tenant is the guard's {@link TenantContext}; nothing here reads an organization id or an
 * amount from the request (the pack size is the platform admin's to choose). A workspace that is
 * not on the AI test list gets 404 from both routes: the feature is absent, not refused. Neither
 * route is ever an AI tool (`ai-actions/registry/never.ts`, reason `ai_credits`).
 */
@Controller('v1/organizations/:orgSlug/ai/credits')
export class AiCreditsController {
  constructor(@Inject(AI_PACKS_SERVICE) private readonly packs: AiPacksService) {}

  /** Allowance, used, held, remaining, reset date, packs and the open request. `billing.view`. */
  @Get()
  @RequireCapability('billing.view')
  credits(@Ctx() context: TenantContext): Promise<AiCreditsView> {
    return this.packs.credits(context);
  }

  /** "Get more credits": one open request at a time (409 while one waits). `billing.manage`. */
  @Post('pack-requests')
  @RequireCapability('billing.manage')
  @HttpCode(201)
  requestPack(@Ctx() context: TenantContext): Promise<AiPackRequestView> {
    return this.packs.requestPack(context);
  }
}
