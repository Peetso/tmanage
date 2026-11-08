import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type {
  ExternalApprovalsService,
  ExternalApproverView,
  SentExternalApproval,
} from './external-approvals.service.js';

export const EXTERNAL_APPROVALS_SERVICE = Symbol.for('tmanage.ExternalApprovalsService');

/**
 * 52-18 — `…/deliverables/:deliverableId/versions/:versionId/external-approvals`: send one
 * version to an outside e-mail for approval, and list who was asked and what they answered.
 *
 * The coarse guard is `deliverable.publish` (internal-only, so a client principal never passes);
 * the service authorizes the same capability against the version's project through the 56-07 link
 * service. NEVER for the AI connector: sending hands an outsider access, which an AI never issues.
 * The outsider's side is the 56-07 `v1/public/links/:token` routes (open, code, decision).
 */
@Controller('v1/organizations/:orgSlug/deliverables/:deliverableId/versions/:versionId')
export class ExternalApprovalsController {
  constructor(
    @Inject(EXTERNAL_APPROVALS_SERVICE) private readonly service: ExternalApprovalsService,
  ) {}

  @Post('external-approvals')
  @HttpCode(201)
  @RequireCapability('deliverable.publish')
  async send(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Param('versionId') versionId: string,
    @Body() body: unknown,
  ): Promise<SentExternalApproval> {
    return this.service.send(context, principal, deliverableId, versionId, body);
  }

  @Get('external-approvals')
  @RequireCapability('deliverable.publish')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Param('versionId') versionId: string,
  ): Promise<{ readonly approvers: readonly ExternalApproverView[] }> {
    return {
      approvers: await this.service.list(context, principal, deliverableId, versionId),
    };
  }
}
