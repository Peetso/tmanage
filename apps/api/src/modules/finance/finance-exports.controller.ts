import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
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
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { FinanceExportView, FinanceExportsService } from './finance-exports.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

export const FINANCE_EXPORTS_SERVICE = Symbol.for('tmanage.FinanceExportsService');

const ZIP_CONTENT_TYPE = 'application/zip';

/** The one method the download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * 52-11 — accounting export by file under `/v1/organizations/:orgSlug/finance/exports`.
 * Capability stand-ins (no `capabilities.ts` edit): `invoice.export` → `finance.manage` plus a
 * fresh step-up (`x-reauth-token`, the gate `invoice.send` uses); the history list →
 * `finance.view`. The export is a mass egress: 5 per hour per organization (SEC-10), audited before
 * the bytes leave (fails closed), served `attachment`, `nosniff`, `private, no-store`.
 * Org-internal; the POST is never an AI tool (NEVER, `finance_settings`).
 */
@RequireFeature('client_invoicing')
@Controller('v1/organizations/:orgSlug/finance/exports')
export class FinanceExportsController {
  constructor(@Inject(FINANCE_EXPORTS_SERVICE) private readonly service: FinanceExportsService) {}

  @Get()
  @RequireCapability('finance.view')
  list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly exports: readonly FinanceExportView[] }> {
    return this.service.list(context, principal);
  }

  @Post()
  @HttpCode(200)
  @RequireCapability('finance.manage')
  @Throttle('finance_export', {
    perHour: 5,
    key: 'link',
    linkParam: 'orgSlug',
    onStoreError: 'closed',
  })
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
    @Headers('x-reauth-token') reauthToken: string | undefined,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @CurrentSession() session?: AuthenticatedSession,
  ): Promise<StreamableFile> {
    const download = await this.service.create(context, principal, body, {
      reauthToken,
      sessionId: session?.sessionId,
    });
    reply.header('content-type', ZIP_CONTENT_TYPE);
    reply.header('content-length', String(download.zip.byteLength));
    reply.header('content-disposition', `attachment; filename="${download.filename}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    reply.header('x-export-id', download.exportId);
    reply.header('x-manifest-sha256', download.manifestSha256);
    return new StreamableFile(download.zip, {
      type: ZIP_CONTENT_TYPE,
      length: download.zip.byteLength,
    });
  }
}
