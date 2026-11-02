import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { InboundEmailService } from './inbound-email.service.js';
import type {
  InboundAddressView,
  InboundAttachmentView,
  InboundLogEntry,
  TrustResult,
} from './inbound-email.service.js';

/**
 * R21-f (54-12 / 54-12a) — the organization side of inbound e-mail.
 *
 * Capabilities: there is no `integration.manage` in capabilities.ts, so the address routes use
 * `org.manage` (the stand-in the GitHub hooks use for the plan's `integration.manage`); the log,
 * the attachment metadata and trust use `client_request.triage` (internal-only — a client never
 * holds it). The service re-checks with the real org-scoped `authorize()` and refuses a client
 * principal outright.
 *
 * - `GET  …/inbound-email/address`         — the active address, or `null`.
 * - `POST …/inbound-email/address`         — create the one active address (409 `address_exists`).
 * - `POST …/inbound-email/address/rotate`  — a new local part; the old one is marked rotated.
 * - `GET  …/inbound-email/log`             — newest first, keyset cursor; never a body.
 * - `GET  …/inbound-email/:id/attachments` — attachment metadata (no bytes exist yet).
 * - `POST …/inbound-email/:id/trust`       — trust a held mail whose DMARC did not pass.
 * R22-c: the signed JSON intake `POST /v1/public/inbound-email/webhook` is inbound-webhook.controller.ts.
 */
@Controller('v1/organizations/:orgSlug/inbound-email')
export class InboundEmailController {
  constructor(@Inject(InboundEmailService) private readonly service: InboundEmailService) {}

  @Get('address')
  @RequireCapability('org.manage')
  address(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly address: InboundAddressView | null }> {
    return this.service.address(context, principal);
  }

  @Post('address')
  @RequireCapability('org.manage')
  @HttpCode(201)
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Body() body: { readonly defaultProjectId?: unknown } | undefined,
  ): Promise<InboundAddressView> {
    return this.service.createAddress(context, principal, orgSlug, body);
  }

  @Post('address/rotate')
  @RequireCapability('org.manage')
  @HttpCode(200)
  rotate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
  ): Promise<InboundAddressView> {
    return this.service.rotate(context, principal, orgSlug);
  }

  @Get('log')
  @RequireCapability('client_request.triage')
  log(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('cursor') cursor: unknown,
  ): Promise<{ readonly entries: readonly InboundLogEntry[]; readonly nextCursor: string | null }> {
    return this.service.log(context, principal, cursor);
  }

  @Get(':id/attachments')
  @RequireCapability('client_request.triage')
  attachments(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ readonly attachments: readonly InboundAttachmentView[] }> {
    return this.service.attachments(context, principal, id);
  }

  @Post(':id/trust')
  @RequireCapability('client_request.triage')
  @HttpCode(200)
  trust(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<TrustResult> {
    return this.service.trust(context, principal, id);
  }
}
