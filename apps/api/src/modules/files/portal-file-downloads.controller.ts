import { Controller, Get, Headers, Inject, Param, Query, Res } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { FILE_DOWNLOAD_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FileDownloadService } from './file-download.service.js';
import { sendDownload } from './download-response.js';
import type { ReplyWriter } from './download-response.js';

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
    @Headers('range') range: string | undefined,
    @Query('inline') inline: string | undefined,
    @Res() reply: ReplyWriter,
  ): Promise<void> {
    // R4 slice 4: `Range` for media seeking (206), `?inline=1` for a media original only. The
    // reply is sent here (not passthrough) so a 206 is not reset to the route's 200.
    const download = await this.downloads.downloadForClient(context, principal, fileAssetId, {
      range,
      inline: inline === '1',
    });
    sendDownload(download, reply);
  }
}
