import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ATTACHMENT_VERSIONS_SERVICE } from './attachment-versions.service.js';
import type {
  AttachmentHistoryView,
  AttachmentVersionsService,
} from './attachment-versions.service.js';

/**
 * C7 (0228) — a plain attachment's version history: list it, and add a new version (an asset the
 * caller already uploaded through the upload pipeline). The path segment is `:fileId` (as on the
 * tags and comments routes) so the body's `fileAssetId` — the new version — never shares its name.
 * Downloads stay on
 * `GET …/files/:fileAssetId/content`, by each version's own asset id, under the scan policy.
 *
 * The capability gates are coarse (`file.download` to read, `file.upload` to add); the service
 * resolves the asset tenant-scoped and authorizes against its project and audience.
 */
@Controller('v1/organizations/:orgSlug/files/:fileId/versions')
export class AttachmentVersionsController {
  constructor(
    @Inject(ATTACHMENT_VERSIONS_SERVICE) private readonly versions: AttachmentVersionsService,
  ) {}

  @Get()
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileAssetId: string,
  ): Promise<AttachmentHistoryView> {
    return this.versions.list(context, principal, fileAssetId);
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('file.upload')
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileAssetId: string,
    @Body() body: Record<string, unknown> | undefined,
  ): Promise<AttachmentHistoryView> {
    const raw = body?.['fileAssetId'];
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 36) {
      throw invalid('fileAssetId', 'must be a file id');
    }
    const note = body?.['note'];
    if (note !== undefined && note !== null && typeof note !== 'string') {
      throw invalid('note', 'must be a string or null');
    }
    const cleanNote = typeof note === 'string' && note.trim() !== '' ? note.trim() : null;
    return this.versions.add(context, principal, fileAssetId, {
      fileAssetId: raw.trim(),
      note: cleanNote,
    });
  }
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}
