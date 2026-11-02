import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  Ctx,
  CurrentPrincipal,
  CurrentSession,
  RequireCapability,
} from '../../common/http/decorators.js';
import type { AuthenticatedSession } from '../identity/session.service.js';
import type {
  AgingView,
  ClientInvoicesService,
  InvoiceSummary,
  InvoiceView,
  PullResult,
} from './client-invoices.service.js';

export const CLIENT_INVOICES_SERVICE = Symbol.for('tmanage.ClientInvoicesService');

/**
 * 52-09 — client invoices under `/v1/organizations/:orgSlug/client-invoices`. Capability stand-ins
 * (no `capabilities.ts` edit): `invoice.view` → `finance.view`; `invoice.manage`, `invoice.send`
 * and `invoice.record_payment` → `finance.manage`. The service re-checks each. A send above the
 * org's step-up threshold also needs `x-reauth-token`; `Idempotency-Key` makes a send retry-safe.
 * Org-internal; the client reads only the projection in `portal/portal-invoices.controller.ts`.
 */
@Controller('v1/organizations/:orgSlug')
export class ClientInvoicesController {
  constructor(@Inject(CLIENT_INVOICES_SERVICE) private readonly service: ClientInvoicesService) {}

  @Get('client-invoices')
  @RequireCapability('finance.view')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query() query: Record<string, unknown>,
  ): Promise<{ readonly invoices: readonly InvoiceSummary[]; readonly nextCursor: string | null }> {
    return this.service.list(context, principal, query);
  }

  @Post('client-invoices')
  @HttpCode(201)
  @RequireCapability('finance.manage')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<InvoiceView> {
    return this.service.create(context, principal, body);
  }

  @Get('client-invoices/aging')
  @RequireCapability('finance.view')
  aging(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AgingView> {
    return this.service.aging(context, principal);
  }

  @Get('client-invoices/:invoiceId')
  @RequireCapability('finance.view')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
  ): Promise<InvoiceView> {
    return this.service.get(context, principal, invoiceId);
  }

  @Put('client-invoices/:invoiceId')
  @RequireCapability('finance.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
  ): Promise<InvoiceView> {
    return this.service.update(context, principal, invoiceId, body);
  }

  @Post('client-invoices/:invoiceId/pull')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  pull(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
  ): Promise<PullResult> {
    return this.service.pull(context, principal, invoiceId, body);
  }

  @Post('client-invoices/:invoiceId/send')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  send(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
    @CurrentSession() session?: AuthenticatedSession,
  ): Promise<InvoiceView> {
    return this.service.send(context, principal, invoiceId, body, {
      orgSlug,
      idempotencyKey,
      reauthToken,
      sessionId: session?.sessionId,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post('client-invoices/:invoiceId/mark-sent')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  markSent(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Param('invoiceId') invoiceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
    @CurrentSession() session?: AuthenticatedSession,
  ): Promise<InvoiceView> {
    return this.service.send(
      context,
      principal,
      invoiceId,
      {},
      {
        orgSlug,
        idempotencyKey,
        reauthToken,
        sessionId: session?.sessionId,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      },
      false,
    );
  }

  @Post('client-invoices/:invoiceId/payments')
  @HttpCode(201)
  @RequireCapability('finance.manage')
  payment(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
  ): Promise<InvoiceView> {
    return this.service.recordPayment(context, principal, invoiceId, body, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post('client-invoices/:invoiceId/void')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  void(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
  ): Promise<InvoiceView> {
    return this.service.voidInvoice(context, principal, invoiceId, body, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post('client-invoices/:invoiceId/credit-notes')
  @HttpCode(201)
  @RequireCapability('finance.manage')
  creditNote(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
  ): Promise<InvoiceView> {
    return this.service.creditNote(context, principal, invoiceId, body, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post('client-invoices/:invoiceId/reminders')
  @HttpCode(200)
  @RequireCapability('finance.manage')
  reminder(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Headers('user-agent') userAgent: string | undefined,
    @Ip() ip: string | undefined,
  ): Promise<{ readonly sent: true; readonly recipients: number }> {
    return this.service.reminder(context, principal, invoiceId, body, {
      orgSlug,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  /** The HTML print view: same authorization as the read, every value escaped as plain text. */
  @Get('client-invoices/:invoiceId/print')
  @RequireCapability('finance.view')
  async print(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('invoiceId') invoiceId: string,
    @Query('lang') lang: string | undefined,
    @Res({ passthrough: true }) reply: { header(name: string, value: string): unknown },
  ): Promise<StreamableFile> {
    const html = await this.service.print(context, principal, invoiceId, lang);
    const body = Buffer.from(html, 'utf8');
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-length', String(body.byteLength));
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(body, { type: 'text/html; charset=utf-8' });
  }
}
