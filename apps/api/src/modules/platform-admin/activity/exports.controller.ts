import type { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { NoTenant } from '../../../common/http/decorators.js';
import { platformRequestContext } from '../platform-admin.access.js';
import { CurrentPlatformAdmin, PlatformAdminGuard } from '../platform-admin.guard.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { RequirePlatformPermission } from '../require-platform-permission.decorator.js';
import { PLATFORM_ACTIVITY_SERVICE } from './activity.controller.js';
import type { PlatformActivityService } from './activity.service.js';
import type { PlatformExportJobView, PlatformExportJobsView } from './activity.service.js';

/** The one method the download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/**
 * C6 exports (platform-admin v2 · PA-09), all `platform.activity.export`:
 * - `POST activity/exports {scope, filter, reason?}` → a queued job (itself logged);
 * - `GET activity/exports` — the newest jobs;
 * - `GET activity/exports/:jobId/download` — the file while it lives (24 h), forced save;
 * - `DELETE activity/exports/:jobId` — gone from the list; the worker removes the file.
 */
@Controller('v1/platform/activity/exports')
@NoTenant()
@UseGuards(PlatformAdminGuard)
export class PlatformExportsController {
  constructor(
    @Inject(PLATFORM_ACTIVITY_SERVICE) private readonly service: PlatformActivityService,
  ) {}

  @Post()
  @RequirePlatformPermission('platform.activity.export')
  @HttpCode(201)
  create(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Body() body: { scope?: unknown; filter?: unknown; reason?: unknown },
    @Req() request: object,
  ): Promise<PlatformExportJobView> {
    return this.service.createExport(actor, body ?? {}, platformRequestContext(request));
  }

  @Get()
  @RequirePlatformPermission('platform.activity.export')
  list(@Req() request: object): Promise<PlatformExportJobsView> {
    return this.service.listExports(platformRequestContext(request));
  }

  @Get(':jobId/download')
  @RequirePlatformPermission('platform.activity.export')
  async download(
    @Param('jobId') jobId: string,
    @Req() request: object,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const file = await this.service.download(jobId, platformRequestContext(request));
    reply.header('content-disposition', `attachment; filename="${file.fileName}"`);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return new StreamableFile(file.stream as Readable, {
      type: 'text/csv; charset=utf-8',
      length: file.sizeBytes,
    });
  }

  @Delete(':jobId')
  @RequirePlatformPermission('platform.activity.export')
  @HttpCode(200)
  remove(
    @CurrentPlatformAdmin() actor: PlatformAdminActor,
    @Param('jobId') jobId: string,
    @Body() body: { reason?: unknown },
    @Req() request: object,
  ): Promise<{ readonly deleted: true }> {
    return this.service.deleteExport(actor, jobId, body ?? {}, platformRequestContext(request));
  }
}
