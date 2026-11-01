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

/**
 * R4 slice 8 — the client's twins of the proofing viewer's thread routes, under `/portal`.
 *
 * The same {@link ReviewService} as the studio's, entered through the `client` door: the service
 * refuses any principal that is not a client of a client organization, then asks the download
 * door (the client relation — their request's files, a published deliverable version's file, a
 * reachable chain — before `authorize()`) about the file the thread hangs on. Every refusal is the
 * files module's one 404.
 *
 * What a client may do is narrower and the service holds it: it reads only `client_visible`
 * threads drawn on the version it opened; everything it writes is `client_visible` (an
 * `internal` audience in the body is refused); it resolves, moves, edits and deletes only its
 * own; it may mention the team on the project and contacts of its own client organization.
 * Every view is the review module's explicit projection (people by display name and kind, no
 * staff ids beyond the membership the thread names), swept by the `ClientProjectionInterceptor`.
 */

function requireId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

@Controller('v1/organizations/:orgSlug/portal/files/:fileId/review')
export class PortalFileReviewController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  /** The client-visible threads on the version the client opens, each with its comments. */
  @Get('threads')
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Query('status') status?: string,
  ): Promise<ReviewThreadListView> {
    requireId(fileId, 'fileId');
    return this.review.listThreads(context, principal, 'client', fileId, { status });
  }

  /** Open a client-visible thread (pin, box, drawing, moment or none) with its first comment. */
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
    return this.review.createThread(context, principal, 'client', fileId, body ?? {});
  }
}

@Controller('v1/organizations/:orgSlug/portal/review')
export class PortalReviewThreadsController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  /** Reply on a client-visible thread. */
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
    return this.review.addComment(context, principal, 'client', threadId, body ?? {});
  }

  /** Resolve own thread. */
  @Post('threads/:threadId/resolve')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async resolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('threadId') threadId: string,
  ): Promise<ReviewThreadView> {
    requireId(threadId, 'threadId');
    return this.review.setResolved(context, principal, 'client', threadId, true);
  }

  /** Reopen own resolved thread. */
  @Post('threads/:threadId/unresolve')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async unresolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('threadId') threadId: string,
  ): Promise<ReviewThreadView> {
    requireId(threadId, 'threadId');
    return this.review.setResolved(context, principal, 'client', threadId, false);
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
    return this.review.moveThread(context, principal, 'client', threadId, body ?? {});
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
    return this.review.editComment(context, principal, 'client', commentId, body ?? {});
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
    await this.review.deleteComment(context, principal, 'client', commentId);
  }
}

@Controller('v1/organizations/:orgSlug/portal/projects/:projectId/review')
export class PortalReviewMentionCandidatesController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  /** Who a client may @mention: the team on the project and its own organization's contacts. */
  @Get('mention-candidates')
  @RequireCapability('client_projection.read')
  async search(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<ReviewMentionCandidatesView> {
    requireId(projectId, 'projectId');
    return this.review.mentionCandidates(context, principal, 'client', projectId, {
      q,
      audience: 'client_visible',
      limit,
    });
  }
}
