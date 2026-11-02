import { Controller, Get, Headers, Inject, Ip, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { CLIENT_INVOICES_SERVICE } from '../finance/client-invoices.controller.js';
import type {
  ClientInvoicesService,
  PortalInvoiceSummary,
  PortalInvoiceView,
} from '../finance/client-invoices.service.js';

/**
 * 52-09 — the client's view of its invoices, on the `/portal` path (registered in the finance
 * module beside the service it reads, as the retainer projection is).
 *
 * `client_projection.read`, a client admin or member (a viewer or reviewer is denied: invoices are
 * a client-admin matter), and the invoice's client organization = the principal's own; anything
 * else — another client's invoice, a draft, a void — is a 404, the same answer as an unknown id.
 * The body is the dedicated projection: header, lines (description in the invoice's language, a
 * by-person line names nobody unless `finance.portal_show_names` is on), payments and the public
 * notes. Never cost, rate card, the internal note or a member id. The first read stamps
 * `viewed_at` and a `viewed` event once.
 */
@Controller('v1/organizations/:orgSlug')
export class PortalInvoicesController {
  constructor(@Inject(CLIENT_INVOICES_SERVICE) private readonly invoices: ClientInvoicesService) {}

  @Get('portal/invoices')
  @RequireCapability('client_projection.read')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly invoices: readonly PortalInvoiceSummary[] }> {
    return this.invoices.portalList(context, principal);
  }

  @Get('portal/invoices/:invoiceId')
  @RequireCapability('client_projection.read')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
  ): Promise<PortalInvoiceView> {
    return this.invoices.portalGet(context, principal, invoiceId, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
