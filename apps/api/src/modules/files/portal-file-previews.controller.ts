import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { FILE_PREVIEW_SERVICE } from './file-preview.service.js';
import type { FilePreviewManifestView, FilePreviewService } from './file-preview.service.js';
import { respondWithPreview } from './preview-response.js';
import type { HeaderWriter } from './download-response.js';

/**
 * R4 slice 4 — the client's viewer routes, under `/portal`.
 *
 * The same service as the studio's, entered through the `client` door: the client relation
 * (`FileClientRelation`: their request's files, a published deliverable version's file, and the
 * versions of a reachable chain) decides before `authorize()`, and every refusal is the one 404.
 * The manifest is an explicit projection (no object key, no staff identity) and the
 * `ClientProjectionInterceptor` sweeps it; the derivative bytes are a `StreamableFile` it lets
 * through by name.
 */
@Controller('v1/organizations/:orgSlug/portal/files/:fileAssetId/preview')
export class PortalFilePreviewsController {
  constructor(@Inject(FILE_PREVIEW_SERVICE) private readonly previews: FilePreviewService) {}

  @Get()
  @RequireCapability('file.download')
  async manifest(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Param('fileAssetId') fileAssetId: string,
    @Query('deliverableVersionId') deliverableVersionId: string | undefined,
  ): Promise<FilePreviewManifestView> {
    return this.previews.manifest(context, principal, 'client', {
      orgSlug,
      fileAssetId,
      deliverableVersionId,
    });
  }

  @Get(':previewId/content')
  @RequireCapability('file.download')
  async content(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileAssetId') fileAssetId: string,
    @Param('previewId') previewId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.previews.content(
      context,
      principal,
      'client',
      fileAssetId,
      previewId,
    );
    return respondWithPreview(content, reply);
  }
}
