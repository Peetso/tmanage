import { Controller, Get, Inject, Param, Res, type StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { FILE_DOWNLOAD_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FileDownloadService } from './file-download.service.js';
import { respondWithDownload } from './download-response.js';
import type { HeaderWriter } from './download-response.js';

/**
 * FILE-002 slice C — the studio's download door.
 *
 * `GET …/files/:fileAssetId/content` streams the private object of a `ready` asset, or
 * answers one indistinguishable 404 (`FileDownloadService`). A `GET` carries no CSRF token
 * and needs none; the session cookie and the tenant guard's membership resolution are the
 * whole authentication, re-done on every request (`27` AUTH-12). The return value is a
 * `StreamableFile` so Nest stays in its own response mode — interceptors and the exception
 * filter still shape everything that is not the bytes — and `respondWithDownload` writes the
 * headers the planning documents ask for before the first byte.
 */
@Controller('v1/organizations/:orgSlug/files')
export class FileDownloadsController {
  constructor(@Inject(FILE_DOWNLOAD_SERVICE) private readonly downloads: FileDownloadService) {}

  @Get(':fileAssetId/content')
  @RequireCapability('file.download')
  async content(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileAssetId') fileAssetId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const download = await this.downloads.download(context, principal, fileAssetId);
    return respondWithDownload(download, reply);
  }
}
