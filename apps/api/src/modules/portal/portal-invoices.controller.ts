import {
  Controller,
  Get,
  Headers,
  Inject,
  Ip,
  Param,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { pdfDownload } from '../approvals/record-pdf.controller.js';
import type { HeaderWriter } from '../approvals/record-pdf.controller.js';
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
 *
 * 52-28 (R19-a): the header also carries `documentLabel`, `documentLabelText` (the invoice's
 * language), `taxNotice` (the "not a tax invoice" line when it went out with the document, else
 * null) and `taxRegistrationRef` — never the rule text or the organization's VAT status.
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

  /**
   * 52-13 — "Download PDF": the A4 print document ("Save as PDF" from the browser) behind the
   * same checks as the read above (own client organization, never a draft or void; else 404).
   * Every value is escaped as plain text; nothing runs and nothing is cached.
   */
  @Get('portal/invoices/:invoiceId/print')
  @RequireCapability('client_projection.read')
  async print(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Query('lang') lang: string | undefined,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): Promise<StreamableFile> {
    const html = await this.invoices.portalPrint(context, principal, invoiceId, lang);
    const body = Buffer.from(html, 'utf8');
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-length', String(body.byteLength));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(body, { type: 'text/html; charset=utf-8' });
  }

  /**
   * 52-10 — "Download PDF": the client's own invoice as a PDF, behind the same checks as the read
   * (own client organization, never a draft or void; else 404). `attachment`, `nosniff`, never
   * cached; the file name is the sanitised invoice number only.
   */
  @Get('portal/invoices/:invoiceId/pdf')
  @RequireCapability('client_projection.read')
  async pdf(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Query('lang') lang: string | undefined,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdfDownload(reply, await this.invoices.portalPdf(context, principal, invoiceId, lang));
  }
}
