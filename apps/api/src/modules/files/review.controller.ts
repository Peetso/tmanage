import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { REVIEW_SERVICE } from './review.service.js';
import type {
  CommentInput,
  CreateThreadInput,
  MoveThreadInput,
  ReviewCommentView,
  ReviewMentionCandidatesView,
  ReviewService,
  ReviewThreadListView,
  ReviewThreadView,
} from './review.service.js';
import { RequireFeature } from '../admin/feature-gate.js';

/**
 * R4 slice 5 — the proofing viewer's thread routes (studio). The portal twins are R4 slice 8.
 *
 * Like every tenant controller here, none reads an organization from the body, a header or its
 * own `:orgSlug`: the guard built the `TenantContext`. The coarse gate is the files module's —
 * `file.download` to read, `file.upload` to write — and the service adds the download door's own
 * decision on the file the thread hangs on (one 404 for everything the caller may not see).
 */

function requireId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

@RequireFeature('proofing')
@Controller('v1/organizations/:orgSlug/files/:fileId/review')
export class FileReviewController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  /** A file's threads (all versions, or `?versionId=`), each with its comments. */
  @Get('threads')
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Query('versionId') versionId?: string,
    @Query('status') status?: string,
  ): Promise<ReviewThreadListView> {
    requireId(fileId, 'fileId');
    return this.review.listThreads(context, principal, 'internal', fileId, { versionId, status });
  }

  /** Open a thread (pin, box, drawing, moment, cell or none) with its first comment. */
  @Post('threads')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body() body: CreateThreadInput | undefined,
  ): Promise<ReviewThreadView> {
    requireId(fileId, 'fileId');
    return this.review.createThread(context, principal, 'internal', fileId, body ?? {});
  }
}

@RequireFeature('proofing')
@Controller('v1/organizations/:orgSlug/review')
export class ReviewThreadsController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  /** Reply on a thread. */
  @Post('threads/:threadId/comments')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async reply(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('threadId') threadId: string,
    @Body() body: CommentInput | undefined,
  ): Promise<ReviewCommentView> {
    requireId(threadId, 'threadId');
    return this.review.addComment(context, principal, 'internal', threadId, body ?? {});
  }

  /** Resolve a thread. */
  @Post('threads/:threadId/resolve')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async resolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('threadId') threadId: string,
  ): Promise<ReviewThreadView> {
    requireId(threadId, 'threadId');
    return this.review.setResolved(context, principal, 'internal', threadId, true);
  }

  /** Reopen a resolved thread. */
  @Post('threads/:threadId/unresolve')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async unresolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('threadId') threadId: string,
  ): Promise<ReviewThreadView> {
    requireId(threadId, 'threadId');
    return this.review.setResolved(context, principal, 'internal', threadId, false);
  }

  /** Move own pin (drag) on the version it was drawn on. */
  @Patch('threads/:threadId')
  @RequireCapability('file.upload')
  async move(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('threadId') threadId: string,
    @Body() body: MoveThreadInput | undefined,
  ): Promise<ReviewThreadView> {
    requireId(threadId, 'threadId');
    return this.review.moveThread(context, principal, 'internal', threadId, body ?? {});
  }

  /** Edit own comment within fifteen minutes. */
  @Patch('comments/:commentId')
  @RequireCapability('file.upload')
  async edit(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('commentId') commentId: string,
    @Body() body: CommentInput | undefined,
  ): Promise<ReviewCommentView> {
    requireId(commentId, 'commentId');
    return this.review.editComment(context, principal, 'internal', commentId, body ?? {});
  }

  /** Delete own comment (absent is 204). */
  @Delete('comments/:commentId')
  @RequireCapability('file.upload')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    requireId(commentId, 'commentId');
    await this.review.deleteComment(context, principal, 'internal', commentId);
  }
}

@RequireFeature('proofing')
@Controller('v1/organizations/:orgSlug/projects/:projectId/review')
export class ReviewMentionCandidatesController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  /** Who may be @mentioned on a comment on this project (`audience=client_visible` adds clients). */
  @Get('mention-candidates')
  @RequireCapability('work.read')
  async search(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('q') q?: string,
    @Query('audience') audience?: string,
    @Query('limit') limit?: string,
  ): Promise<ReviewMentionCandidatesView> {
    requireId(projectId, 'projectId');
    return this.review.mentionCandidates(context, principal, 'internal', projectId, {
      q,
      audience,
      limit,
    });
  }
}
