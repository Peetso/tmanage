import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { respondWithDownload } from '../../files/download-response.js';
import type { HeaderWriter } from '../../files/download-response.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { CONTENT_BASE, PLATFORM_CONTENT_SERVICE, supportRequestOf } from './content-http.js';
import type { ContentQuery, PlatformContentService } from './content.service.js';

/**
 * B5 Files (436:17136, SPEC §5.4): the metadata table across TManage storage, Google Drive and
 * OneDrive links (`files?q&projectId&location&scan&deleted`), one file with its versions and the
 * deliverable it backs, the proxied download (audited `file_asset.downloaded` with the support
 * session stamped — a blocked file is refused by the files module), delete (reason required) and
 * restore. A Drive or OneDrive link is addressed with `?kind=drive_file|onedrive_file`. A file that
 * is an approved deliverable version is locked: delete answers 409 with the explanation.
 */
@Controller(CONTENT_BASE)
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformFilesContentController {
  constructor(@Inject(PLATFORM_CONTENT_SERVICE) private readonly content: PlatformContentService) {}

  @Get('files')
  @RequirePlatformPermission('platform.content.view')
  list(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Query() query: ContentQuery,
    @Req() request: object,
  ) {
    return this.content.list(actor, id, 'files', query ?? {}, supportRequestOf(request));
  }

  @Get('files/:fileId')
  @RequirePlatformPermission('platform.content.view')
  item(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Query('kind') kind: string | undefined,
    @Req() request: object,
  ) {
    return this.content.item(actor, id, fileKind(kind), fileId, supportRequestOf(request));
  }

  @Get('files/:fileId/download')
  @RequirePlatformPermission('platform.content.view')
  async download(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Req() request: object,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const download = await this.content.download(actor, id, fileId, supportRequestOf(request));
    return respondWithDownload(download, reply);
  }

  @Get('deliverables/:deliverableId')
  @RequirePlatformPermission('platform.content.view')
  deliverable(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('deliverableId') deliverableId: string,
    @Req() request: object,
  ) {
    return this.content.deliverable(actor, id, deliverableId, supportRequestOf(request));
  }

  @Delete('files/:fileId')
  @RequirePlatformPermission('platform.content.moderate')
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Query('kind') kind: string | undefined,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.remove(
      actor,
      id,
      fileKind(kind),
      fileId,
      body ?? {},
      supportRequestOf(request),
    );
  }

  @Post('files/:fileId/restore')
  @RequirePlatformPermission('platform.content.moderate')
  @HttpCode(200)
  restore(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Query('kind') kind: string | undefined,
    @Body() body: { readonly reason?: unknown },
    @Req() request: object,
  ) {
    return this.content.restore(
      actor,
      id,
      fileKind(kind),
      fileId,
      body ?? {},
      supportRequestOf(request),
    );
  }
}

function fileKind(kind: string | undefined): 'file' | 'drive_file' | 'onedrive_file' {
  return kind === 'drive_file' || kind === 'onedrive_file' ? kind : 'file';
}
