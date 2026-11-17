import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { pdfDownload } from '../approvals/record-pdf.controller.js';
import type { HeaderWriter } from '../approvals/record-pdf.controller.js';
import type {
  ConvertedQuote,
  QuoteDetail,
  QuotesService,
  QuoteView,
  SentQuote,
} from './quotes.service.js';

export const QUOTES_SERVICE = Symbol.for('tmanage.QuotesService');

/**
 * 52-08 — `/v1/organizations/:orgSlug/quotes`: create, list, get, update a draft, send, convert. The route
 * guard asks `project.manage`; {@link QuotesService} authorizes again at organization scope and
 * loads the quote tenant-scoped (another organization's id is a 404). The outsider side has no
 * route here: it is the 56-07 link (`/v1/public/links/:token`) with the `quote` target adapter.
 */
@Controller('v1/organizations/:orgSlug/quotes')
export class QuotesController {
  constructor(@Inject(QUOTES_SERVICE) private readonly service: QuotesService) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly quotes: readonly QuoteView[] }> {
    return { quotes: await this.service.list(context, principal, { status, limit }) };
  }

  @Post()
  @RequireCapability('project.manage')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<QuoteDetail> {
    return this.service.create(context, principal, body);
  }

  @Get(':quoteId')
  @RequireCapability('project.manage')
  get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('quoteId') quoteId: string,
  ): Promise<QuoteDetail> {
    return this.service.get(context, principal, quoteId);
  }

  @Put(':quoteId')
  @RequireCapability('project.manage')
  update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
  ): Promise<QuoteDetail> {
    return this.service.updateDraft(context, principal, quoteId, body);
  }

  @Post(':quoteId/send')
  @RequireCapability('project.manage')
  @HttpCode(200)
  send(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
  ): Promise<SentQuote> {
    return this.service.send(context, principal, quoteId, body);
  }

  /** 52-08 — an accepted quote becomes a project; a second call returns the same project. */
  @Post(':quoteId/convert')
  @RequireCapability('project.manage')
  @HttpCode(200)
  convert(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
  ): Promise<ConvertedQuote> {
    return this.service.convert(context, principal, quoteId, body);
  }

  /** 52-10 — the quote as a PDF download (`attachment`, `nosniff`, never cached). */
  @Get(':quoteId/pdf')
  @RequireCapability('project.manage')
  async pdf(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('quoteId') quoteId: string,
    @Query('lang') lang: string | undefined,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdfDownload(reply, await this.service.pdf(context, principal, quoteId, lang));
  }
}

/** 52-10 — the client's own sent quote as a PDF, in the portal (anything else is a 404). */
@Controller('v1/organizations/:orgSlug/portal/quotes')
export class PortalQuotesController {
  constructor(@Inject(QUOTES_SERVICE) private readonly service: QuotesService) {}

  @Get(':quoteId/pdf')
  @RequireCapability('client_projection.read')
  async pdf(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('quoteId') quoteId: string,
    @Query('lang') lang: string | undefined,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    return pdfDownload(reply, await this.service.portalPdf(context, principal, quoteId, lang));
  }
}
