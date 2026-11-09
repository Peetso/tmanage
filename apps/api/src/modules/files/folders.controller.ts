import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { FILE_FOLDERS_SERVICE } from '../../common/http/tokens.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  FileFolderPlacementView,
  FileFolderView,
  FileFoldersService,
  ProjectFileView,
} from './folders.service.js';

/**
 * x332's HTTP surface — file folders (Files module).
 *
 * Two shapes of resource on one controller. A *folder* is a sub-resource of a project
 * (`…/projects/:id/folders`); a *placement* hangs on a file (`…/files/:fileId/folder`). The service
 * resolves project, folder and file tenant-scoped before it authorizes or writes, so a cross-tenant
 * id is a 404. The capability gate is the files module's coarse pair — `file.download` to read,
 * `file.upload` to create / delete / move — the same doors the upload and download surfaces use; the
 * row-level decision is the service's, against the resolved project or file.
 */

interface CreateFolderBody {
  readonly name?: unknown;
}

interface MoveBody {
  readonly folderId?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class FileFoldersController {
  constructor(@Inject(FILE_FOLDERS_SERVICE) private readonly folders: FileFoldersService) {}

  @Get('projects/:projectId/folders')
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly folders: readonly FileFolderView[] }> {
    return { folders: await this.folders.listFolders(context, principal, projectId) };
  }

  /** FIX3 item 11 (FIL-01 Files hub): the project's ready files, newest change first. */
  @Get('projects/:projectId/files')
  @RequireCapability('file.download')
  async files(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly files: readonly ProjectFileView[] }> {
    return { files: await this.folders.listProjectFiles(context, principal, projectId) };
  }

  @Get('projects/:projectId/folders/:folderId/files')
  @RequireCapability('file.download')
  async contents(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('folderId') folderId: string,
  ): Promise<{ readonly files: readonly FileFolderPlacementView[] }> {
    return {
      files: await this.folders.listFolderContents(context, principal, projectId, folderId),
    };
  }

  @Post('projects/:projectId/folders')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateFolderBody,
  ): Promise<FileFolderView> {
    return this.folders.create(context, principal, projectId, body?.name);
  }

  @Delete('projects/:projectId/folders/:folderId')
  @RequireCapability('file.delete')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('folderId') folderId: string,
  ): Promise<void> {
    await this.folders.delete(context, principal, projectId, folderId);
  }

  @Put('files/:fileId/folder')
  @RequireCapability('file.upload')
  async move(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body() body: MoveBody,
  ): Promise<FileFolderPlacementView> {
    return this.folders.move(context, principal, fileId, folderIdOf(body));
  }
}

/** The move body carries `folderId`: a string to file into, or `null` to send the file to root. */
function folderIdOf(body: MoveBody): string | null {
  const raw = body?.folderId;
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'folderId', message: 'must be a folder id string or null' },
    ]);
  }
  return raw;
}
