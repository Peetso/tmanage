import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { FILE_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { FileCommentsService, FileCommentView } from './comments.service.js';

/**
 * x333's HTTP surface — file comments (Files module).
 *
 * The thread hangs on a file asset (`…/files/:fileId/comments`), the way document comments hang on a
 * document. Like every tenant-scoped controller here it never reads `organizationId` from the body,
 * a header, or its own `:orgSlug` segment: it passes on the `TenantContext` the guard built. The
 * `fileId` in the path is resolved tenant-scoped BEFORE any write in the service (the Known trap):
 * a cross-tenant `fileId` is a 404 with nothing written. The coarse capability gate is the files
 * module's — `file.download` to list, `file.upload` to comment / delete; the row-level decision
 * (may this caller see this file, is this their own comment) is the service's.
 */

/** Add-a-comment request body. */
interface AddCommentBody {
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/files/:fileId/comments')
export class FileCommentsController {
  constructor(@Inject(FILE_COMMENTS_SERVICE) private readonly comments: FileCommentsService) {}

  /** List a file's comments, oldest first, for a caller who may read the file (`file.download`). */
  @Get()
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
  ): Promise<{ readonly comments: readonly FileCommentView[] }> {
    requireFileId(fileId);
    return { comments: await this.comments.list(context, principal, fileId) };
  }

  /** Comment on a file (`file.upload`). Empty body → 400. */
  @Post()
  @RequireCapability('file.upload')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body() body: AddCommentBody,
  ): Promise<FileCommentView> {
    requireFileId(fileId);
    return this.comments.add(context, principal, fileId, body?.body);
  }

  /** Delete own comment (`file.upload`). Another member's comment is refused; absent is 204. */
  @Delete(':commentId')
  @RequireCapability('file.upload')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    requireFileId(fileId);
    requireCommentId(commentId);
    await this.comments.remove(context, principal, fileId, commentId);
  }
}

/** A path `fileId` is always required and always a non-empty string. */
function requireFileId(fileId: unknown): asserts fileId is string {
  if (typeof fileId !== 'string' || fileId === '') {
    throw new ApiError(400, 'validation_failed', 'fileId is required', [
      { field: 'fileId', message: 'must be a non-empty string' },
    ]);
  }
}

/** A path `commentId` is always required and always a non-empty string. */
function requireCommentId(commentId: unknown): asserts commentId is string {
  if (typeof commentId !== 'string' || commentId === '') {
    throw new ApiError(400, 'validation_failed', 'commentId is required', [
      { field: 'commentId', message: 'must be a non-empty string' },
    ]);
  }
}
