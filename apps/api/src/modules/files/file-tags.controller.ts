import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { FILE_TAGS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FileTagAssignmentView, FileTagView, FileTagsService } from './file-tags.service.js';

/**
 * x270's HTTP surface — file tags (Files module).
 *
 * Two shapes of resource on one controller. Tag *definitions* are org-scoped (`…/file-tags`); a tag
 * *assignment* is a sub-resource of a file (`…/files/:fileId/tags/:tagId`), the way work labels hang
 * on a work item — the parent id is in the path, and the service resolves the file tenant-scoped
 * before it authorizes or writes. The capability gate is coarse (`file.download` to list,
 * `file.upload` to define / assign / remove, the same caps the upload and download doors use); the
 * row-level decision is the service's, against the resolved file.
 */

interface DefineTagBody {
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class FileTagsController {
  constructor(@Inject(FILE_TAGS_SERVICE) private readonly tags: FileTagsService) {}

  @Get('file-tags')
  @RequireCapability('file.download')
  async list(@Ctx() context: TenantContext): Promise<{ readonly tags: readonly FileTagView[] }> {
    return { tags: await this.tags.listDefinitions(context) };
  }

  @Post('file-tags')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async define(@Ctx() context: TenantContext, @Body() body: DefineTagBody): Promise<FileTagView> {
    return this.tags.define(context, body?.name);
  }

  @Get('files/:fileId/tags')
  @RequireCapability('file.download')
  async listForFile(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
  ): Promise<{ readonly tags: readonly FileTagAssignmentView[] }> {
    return { tags: await this.tags.listForFile(context, principal, fileId) };
  }

  @Put('files/:fileId/tags/:tagId')
  @RequireCapability('file.upload')
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Param('tagId') tagId: string,
  ): Promise<FileTagAssignmentView> {
    return this.tags.assign(context, principal, fileId, tagId);
  }

  @Delete('files/:fileId/tags/:tagId')
  @RequireCapability('file.upload')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    await this.tags.remove(context, principal, fileId, tagId);
  }
}
