import { Controller, Delete, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { FILE_DELETE_SERVICE } from './file-delete.service.js';
import type { FileDeleteService } from './file-delete.service.js';

/**
 * FIX5 item 5 (B-N5) — delete an uploaded file and undo it.
 *
 * - `DELETE /v1/organizations/:orgSlug/files/:fileId` → 204. Soft delete with the restore window.
 * - `POST /v1/organizations/:orgSlug/files/:fileId/restore` → 204. Undo inside the window.
 *
 * The route gate is `file.upload` (the uploader is an ordinary member); the service decides the
 * row: the uploader, a holder of `file.delete` on the file's project, else 403 (see
 * `FileDeleteService`).
 */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function requireFileId(fileId: string): string {
  if (!ID_SHAPE.test(fileId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  return fileId.toLowerCase();
}

@Controller('v1/organizations/:orgSlug/files')
export class FileDeleteController {
  constructor(@Inject(FILE_DELETE_SERVICE) private readonly files: FileDeleteService) {}

  @Delete(':fileId')
  @RequireCapability('file.upload')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
  ): Promise<void> {
    await this.files.softDelete(context, principal, requireFileId(fileId));
  }

  @Post(':fileId/restore')
  @RequireCapability('file.upload')
  @HttpCode(204)
  async restore(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
  ): Promise<void> {
    await this.files.restore(context, principal, requireFileId(fileId));
  }
}
