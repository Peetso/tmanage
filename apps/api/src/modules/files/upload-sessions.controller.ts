import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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
 * FILE-001's internal surface — the studio's upload sessions.
 *
 * `file.upload` on every route, which `packages/domain` gives every internal role but
 * `guest`. The capability is not in `INTERNAL_ONLY_CAPABILITIES` — clients upload too — so
 * the guard passes a client principal here; the service then refuses one with its own 403,
 * because the client's door is `/portal/upload-sessions`, for the reason `PortalController`
 * gives: a client surface is a path of its own rather than a branch on an internal one.
 *
 * The paths follow the repository (`/v1/organizations/:orgSlug/...`, a slug) rather than
 * `openapi.yaml`'s `{organizationId}`; the `cancel` route and the two reads are not in the
 * contract at all (recorded divergences — `13-ENGINEERING-EXECUTION-SPEC` §3 requires
 * cancel, and a screen that shows "uploading" needs a read).
 */
@Controller('v1/organizations/:orgSlug/upload-sessions')
export class UploadSessionsController {
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
    return this.files.create(context, principal, { ...parsed, idempotencyKey });
  }

  @Get()
  @RequireCapability('file.upload')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId?: string,
  ): Promise<{ readonly uploadSessions: readonly UploadSessionView[] }> {
    return {
      uploadSessions: await this.files.list(context, principal, projectId ? { projectId } : {}),
    };
  }

  @Get(':uploadSessionId')
  @RequireCapability('file.upload')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('uploadSessionId') uploadSessionId: string,
  ): Promise<UploadSessionView> {
    return this.files.get(context, principal, uploadSessionId);
  }

  /** `openapi.yaml`: 202, "Upload accepted for verification and scan". */
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
    return this.files.complete(context, principal, uploadSessionId, parts);
  }

  @Post(':uploadSessionId/cancel')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async cancel(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('uploadSessionId') uploadSessionId: string,
  ): Promise<UploadSessionView> {
    return this.files.cancel(context, principal, uploadSessionId);
  }
}
