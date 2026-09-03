import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { API_CONFIG, FILES_SERVICE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FileAssetView, FilesService, UploadSessionView } from './files.service.js';
import { parseParts, parseUploadBody, requiredIdempotencyKey } from './upload-input.js';
import type { ValidationDetail } from './upload-input.js';

/**
 * FILE-001's client surface — a client attaching a file to their own request (CL-06's
 * "files").
 *
 * Under `/portal`, so `ClientProjectionInterceptor` sweeps every response for the forbidden
 * fields and `sec-001` drives the path through §11's boundary grid. The same parser as the
 * studio's door; the service decides what a client may upload for (`purpose-policy.ts`)
 * and refuses an internal principal here with its own 403.
 */
@Controller('v1/organizations/:orgSlug/portal/upload-sessions')
export class PortalUploadSessionsController {
  constructor(
    @Inject(FILES_SERVICE) private readonly files: FilesService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post()
  @RequireCapability('file.upload')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') idempotencyHeader: string | undefined,
    @Body() body: unknown,
  ): Promise<UploadSessionView> {
    const details: ValidationDetail[] = [];
    const idempotencyKey = requiredIdempotencyKey(idempotencyHeader, details);
    const parsed = parseUploadBody(body, this.config.uploadMaxBytes, details);
    if (details.length > 0 || !idempotencyKey || !parsed) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.files.createForClient(context, principal, { ...parsed, idempotencyKey });
  }

  /** The client's own uploads in flight or done — "client files" on WEB-006's screen. */
  @Get()
  @RequireCapability('file.upload')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly uploadSessions: readonly UploadSessionView[] }> {
    return { uploadSessions: await this.files.listForClient(context, principal) };
  }

  @Post(':uploadSessionId/complete')
  @RequireCapability('file.upload')
  @HttpCode(202)
  async complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('uploadSessionId') uploadSessionId: string,
    @Body() body: unknown,
  ): Promise<FileAssetView> {
    const details: ValidationDetail[] = [];
    const parts = parseParts(body, details);
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.files.completeForClient(context, principal, uploadSessionId, parts);
  }

  @Post(':uploadSessionId/cancel')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async cancel(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('uploadSessionId') uploadSessionId: string,
  ): Promise<UploadSessionView> {
    return this.files.cancelForClient(context, principal, uploadSessionId);
  }
}
