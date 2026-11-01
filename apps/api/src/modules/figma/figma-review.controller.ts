import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { REVIEW_SERVICE } from '../files/review.service.js';
import type {
  CreateThreadInput,
  ReviewService,
  ReviewThreadListView,
  ReviewThreadView,
} from '../files/review.service.js';

/**
 * R4 slice 13 — threads on Figma frames (`subject_type = 'figma_frame'`). Registered in the files
 * module beside the file thread routes: the same {@link ReviewService}, which asks the Figma
 * module's `FigmaAccess` whether the caller may read the frame's link (one 404 otherwise).
 * Replies, resolve, move, edit and delete use the existing `review/threads/:threadId` routes.
 */
@Controller('v1/organizations/:orgSlug/figma/frames/:frameId/review')
export class FigmaFrameReviewController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  @Get('threads')
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Query('status') status?: string,
  ): Promise<ReviewThreadListView> {
    return this.review.listFrameThreads(context, principal, 'internal', frameId, { status });
  }

  @Post('threads')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Body() body: CreateThreadInput | undefined,
  ): Promise<ReviewThreadView> {
    return this.review.createFrameThread(context, principal, 'internal', frameId, body ?? {});
  }
}

@Controller('v1/organizations/:orgSlug/portal/figma/frames/:frameId/review')
export class PortalFigmaFrameReviewController {
  constructor(@Inject(REVIEW_SERVICE) private readonly review: ReviewService) {}

  @Get('threads')
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Query('status') status?: string,
  ): Promise<ReviewThreadListView> {
    return this.review.listFrameThreads(context, principal, 'client', frameId, { status });
  }

  @Post('threads')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Body() body: CreateThreadInput | undefined,
  ): Promise<ReviewThreadView> {
    return this.review.createFrameThread(context, principal, 'client', frameId, body ?? {});
  }
}
