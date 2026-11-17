import { Controller, Get, Inject, Param, Query, Res, StreamableFile } from '@nestjs/common';
import { parseProjectExportFormat, PROJECT_EXPORT_FORMATS } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { Throttle } from '../rate-limits/throttle-policies.js';
import { ProjectExportService } from './project-export.service.js';

/** The one method the download needs of the framework reply: set a header before the first byte. */
interface HeaderWriter {
  header(name: string, value: string): unknown;
}

/** A row id as the API issues them (uuid-shaped); anything else cannot name a project. */
const ROW_ID = /^[0-9a-zA-Z-]{1,36}$/u;

/**
 * 54-29 — `GET …/projects/:projectId/export?format=csv|json`, behind `work.export`.
 *
 * The format is checked against the shared allow-list before any read (400). The service makes the
 * per-project decision (404 for a project the caller cannot read, 403 without `work.export` on it),
 * caps the rows (413) and writes the audit row before the bytes leave. The download carries the
 * sibling exports' headers: `attachment` with a slug-built file name, `nosniff`, `private,
 * no-store`. A mass egress, so it is rate-limited per organization like the finance export.
 */
@Controller('v1/organizations/:orgSlug/projects/:projectId/export')
export class ProjectExportController {
  constructor(@Inject(ProjectExportService) private readonly service: ProjectExportService) {}

  @Get()
  @RequireCapability('work.export')
  @Throttle('project_export', {
    perHour: 30,
    key: 'link',
    linkParam: 'orgSlug',
    onStoreError: 'closed',
  })
  async export(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
    @Query('format') format?: string,
  ): Promise<StreamableFile> {
    const parsed = parseProjectExportFormat(format);
    if (parsed === null) {
      throw new ApiError(400, 'validation_failed', 'The export format is invalid', [
        { field: 'format', message: `must be one of ${PROJECT_EXPORT_FORMATS.join(', ')}` },
      ]);
    }
    if (typeof projectId !== 'string' || !ROW_ID.test(projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const download = await this.service.export(context, principal, projectId, parsed);
    reply.header('content-type', download.contentType);
    reply.header('content-length', String(download.body.byteLength));
    reply.header('content-disposition', `attachment; filename="${download.fileName}"`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    return new StreamableFile(download.body, {
      type: download.contentType,
      length: download.body.byteLength,
    });
  }
}
