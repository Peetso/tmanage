import { Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { FILE_PREVIEW_SERVICE } from './file-preview.service.js';
import type {
  FilePreviewManifestView,
  FilePreviewService,
  PreviewRetryView,
} from './file-preview.service.js';
import { respondWithPreview } from './preview-response.js';
import type { HeaderWriter } from './download-response.js';

/**
 * R4 slice 4 — the studio viewer's routes.
 *
 * `GET …/files/:fileAssetId/preview` is the viewer manifest; `GET …/preview/:previewId/content`
 * the bytes of one TManage-made derivative (inline, immutable, sandboxed); `POST …/preview/retry`
 * puts failed previews back in the queue. The coarse gates are `file.download` to read and
 * `file.upload` to retry; the service runs the download door's own decision on the file
 * (`FileDownloadService.resolve`) and answers its one 404.
 */
@Controller('v1/organizations/:orgSlug/files/:fileAssetId/preview')
export class FilePreviewsController {
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
    return this.previews.manifest(context, principal, 'internal', {
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
      'internal',
      fileAssetId,
      previewId,
    );
    return respondWithPreview(content, reply);
  }

  @Post('retry')
  @HttpCode(200)
  @RequireCapability('file.upload')
  async retry(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileAssetId') fileAssetId: string,
  ): Promise<PreviewRetryView> {
    return this.previews.retry(context, principal, fileAssetId);
  }
}
