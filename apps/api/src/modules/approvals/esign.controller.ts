import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { decisionEvidence } from './approvals.controller.js';
import type { RequestLike } from './approvals.controller.js';
import type {
  PortalSignatureListView,
  PortalSignatureView,
  SignatureCodeSentView,
  SignatureRequestListView,
  SignatureRequestView,
} from './esign.js';
import type { EsignService } from './esign.service.js';

/** Slice-private token, so `tokens.ts` stays untouched. */
export const ESIGN_SERVICE = Symbol.for('tmanage.EsignService');

/**
 * 52-26 · the team's signature requests on a deliverable version. The route capability is the
 * coarse ceiling; the service re-checks it on the request's own project, staff only. The tenant is
 * the session's context; no organization id is read from the request.
 */
@Controller('v1/organizations/:orgSlug/signature-requests')
export class EsignController {
  constructor(@Inject(ESIGN_SERVICE) private readonly esign: EsignService) {}

  @Post()
  @HttpCode(200)
  @RequireCapability('deliverable.publish')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: Readonly<Record<string, unknown>>,
  ): Promise<SignatureRequestView> {
    return this.esign.create(context, principal, body ?? {});
  }

  @Get()
  @RequireCapability('approval.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('deliverableVersionId') deliverableVersionId: unknown,
  ): Promise<SignatureRequestListView> {
    return this.esign.list(context, principal, deliverableVersionId);
  }

  @Get(':signatureRequestId')
  @RequireCapability('approval.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
  ): Promise<SignatureRequestView> {
    return this.esign.get(context, principal, requestId);
  }

  @Post(':signatureRequestId/cancel')
  @HttpCode(200)
  @RequireCapability('deliverable.publish')
  cancel(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
  ): Promise<SignatureRequestView> {
    return this.esign.cancel(context, principal, requestId);
  }

  @Post(':signatureRequestId/remind')
  @HttpCode(200)
  @RequireCapability('deliverable.publish')
  remind(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
  ): Promise<SignatureRequestView> {
    return this.esign.remind(context, principal, requestId);
  }
}

/**
 * 52-26 · the portal: the requests addressed to the signed-in client contact, their one-time code
 * and the signature. A request not addressed to the caller is a 404.
 */
@Controller('v1/organizations/:orgSlug/portal/signature-requests')
export class PortalEsignController {
  constructor(@Inject(ESIGN_SERVICE) private readonly esign: EsignService) {}

  @Get()
  @RequireCapability('client_projection.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PortalSignatureListView> {
    return this.esign.listMine(context, principal);
  }

  @Get(':signatureRequestId')
  @RequireCapability('client_projection.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
  ): Promise<PortalSignatureView> {
    return this.esign.getMine(context, principal, requestId);
  }

  @Post(':signatureRequestId/code')
  @HttpCode(200)
  @RequireCapability('client_projection.read')
  code(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
  ): Promise<SignatureCodeSentView> {
    return this.esign.sendCode(context, principal, requestId);
  }

  @Post(':signatureRequestId/sign')
  @HttpCode(200)
  @RequireCapability('client_projection.read')
  sign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('signatureRequestId') requestId: string,
    @Body() body: Readonly<Record<string, unknown>>,
    @Req() request: RequestLike,
  ): Promise<PortalSignatureView> {
    return this.esign.sign(context, principal, requestId, body ?? {}, decisionEvidence(request));
  }
}
