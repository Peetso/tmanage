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
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { NoTenant, Public } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { platformRequestContext } from '../platform-admin/platform-admin.access.js';
import {
  CurrentPlatformAdmin,
  PlatformAdminGuard,
} from '../platform-admin/platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { RequirePlatformPermission } from '../platform-admin/require-platform-permission.decorator.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import type { ThrottleLimits } from '../rate-limits/durable-rate-limiter.js';
import { MAX_REQUEST_BYTES } from './security-report-content.js';
import type {
  SecurityReportDetail,
  SecurityReportSummary,
  SecurityReportsService,
} from './security-reports.service.js';

export const SECURITY_REPORTS_SERVICE = Symbol.for('tmanage.SecurityReportsService');

/** 56-05 budget for the report door: a researcher sends a handful, a script hits the wall. */
export const SECURITY_REPORT_SUBMIT_LIMITS: ThrottleLimits = {
  perMinute: 3,
  perHour: 10,
  key: 'ip',
  onStoreError: 'closed',
};

interface PublicRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

interface PublicReply {
  header(name: string, value: string): unknown;
}

/**
 * 56-17 — `POST /v1/public/security-reports` → `{ reference }` only. No session, no tenant, no
 * CSRF (it establishes no authority). Never cached, never indexed, no referrer.
 */
@Controller('v1/public/security-reports')
export class PublicSecurityReportsController {
  constructor(@Inject(SECURITY_REPORTS_SERVICE) private readonly service: SecurityReportsService) {}

  @Post()
  @Public()
  @Throttle('security_report_submit', SECURITY_REPORT_SUBMIT_LIMITS)
  @HttpCode(201)
  async submit(
    @Body() body: unknown,
    @Req() request: PublicRequest,
    @Res({ passthrough: true }) reply: PublicReply,
  ): Promise<{ readonly reference: string }> {
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    reply.header('referrer-policy', 'no-referrer');
    const fields =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Readonly<Record<string, unknown>>)
        : {};
    if (Buffer.byteLength(JSON.stringify(fields), 'utf8') > MAX_REQUEST_BYTES) {
      throw new ApiError(400, 'validation_failed', 'The report is too long.', [
        { field: 'body', message: `the whole report at most ${MAX_REQUEST_BYTES} bytes` },
      ]);
    }
    const acceptLanguage = request.headers['accept-language'];
    const result = await this.service.submit({
      body: fields,
      ip: request.ip,
      acceptLanguage: typeof acceptLanguage === 'string' ? acceptLanguage : undefined,
      correlationId: requireRequestState(request).correlationId,
    });
    if (result.kind === 'rate_limited') {
      reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many reports. Try again later.');
    }
    return { reference: result.reference };
  }
}

/**
 * 56-17 — `/v1/platform/security-reports`: the confidential triage list, one report, and its
 * status / credit. `platform.settings.edit` for all three (super admin by default): there is no
 * `platform.settings.view` key yet, and a report can name an unfixed hole.
 */
@Controller('v1/platform/security-reports')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformSecurityReportsController {
  constructor(@Inject(SECURITY_REPORTS_SERVICE) private readonly service: SecurityReportsService) {}

  @Get()
  @RequirePlatformPermission('platform.settings.edit')
  async list(
    @Query('status') status: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() request: object,
  ): Promise<{ readonly reports: readonly SecurityReportSummary[] }> {
    const reports = await this.service.list({ status, limit }, platformRequestContext(request));
    return { reports };
  }

  @Get(':id')
  @RequirePlatformPermission('platform.settings.edit')
  get(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Req() request: object,
  ): Promise<SecurityReportDetail> {
    return this.service.get(actor, id, platformRequestContext(request));
  }

  @Put(':id')
  @RequirePlatformPermission('platform.settings.edit')
  update(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Body() body: Readonly<Record<string, unknown>> | undefined,
    @Req() request: object,
  ): Promise<SecurityReportDetail> {
    return this.service.update(actor, id, body ?? {}, platformRequestContext(request));
  }
}
