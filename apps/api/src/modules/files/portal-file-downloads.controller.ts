import { Controller, Get, Inject, Param, Res, type StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { FILE_DOWNLOAD_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FileDownloadService } from './file-download.service.js';
import { respondWithDownload } from './download-response.js';
import type { HeaderWriter } from './download-response.js';

/**
 * FILE-002 slice C — the client's download door, under `/portal`.
 *
 * The same gate as the studio's, entered through `downloadForClient`, which refuses an
 * internal principal and then holds the client to their own request's file
 * (`FileDownloadService`). Under `/portal` the `ClientProjectionInterceptor` sweeps the
 * response; a `StreamableFile` carries bytes and no fields, and the interceptor lets it
 * through by name rather than walking a stream's internals.
 */
@Controller('v1/organizations/:orgSlug/portal/files')
export class PortalFileDownloadsController {
  constructor(@Inject(FILE_DOWNLOAD_SERVICE) private readonly downloads: FileDownloadService) {}

  @Get(':fileAssetId/content')
  @RequireCapability('file.download')
  async content(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileAssetId') fileAssetId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const download = await this.downloads.downloadForClient(context, principal, fileAssetId);
    return respondWithDownload(download, reply);
  }
}
