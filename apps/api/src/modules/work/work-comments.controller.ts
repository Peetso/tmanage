import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { IdempotencyReplayInterceptor } from '../../common/http/idempotency-replay.interceptor.js';
import { WORK_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  WorkCommentView,
  WorkCommentsService,
  WorkMentionCandidateView,
} from './work-comments.service.js';

/**
 * x147's HTTP surface — a work item's comments / activity (Work module 7).
 *
 * A sub-resource of the work item, the way `POST :workItemId/transitions` and
 * `:workItemId/checklist` are: the parent id is in the path, and the service resolves it
 * tenant-scoped before it authorizes or writes. This controller reads no `organizationId` from
 * anywhere — `TenantContextGuard` built the `TenantContext` from a membership row, and there is
 * no field on the body below for a caller to supply one.
 *
 * The capability gate is coarse (`work.read` to list, `work.update` to write); the row-level
 * decision — may this principal act on *this* item, given its project and audience — is the
 * service's, against the resolved parent. Comments are internal-only: they are authored by a
 * membership of the studio and never projected to a client surface.
 */

/** `work_item_comments.body` is `TEXT`; this bounds a single comment to a sane maximum. */
const MAX_BODY_LENGTH = 5000;

interface CreateCommentBody {
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/comments')
export class WorkCommentsController {
  constructor(@Inject(WORK_COMMENTS_SERVICE) private readonly comments: WorkCommentsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly comments: readonly WorkCommentView[] }> {
    return { comments: await this.comments.list(context, principal, workItemId) };
  }

  /**
   * 53-11: who a comment on this item may @mention — only people who can see the item. Behind
   * `work.read`, and the same 404 as the list for an item the caller cannot read.
   */
  @Get('mention-candidates')
  @RequireCapability('work.read')
  async mentionCandidates(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly candidates: readonly WorkMentionCandidateView[] }> {
    const parsed = limit === undefined ? 10 : Number(limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 25) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'limit', message: 'must be a whole number from 1 to 25' },
      ]);
    }
    return {
      candidates: await this.comments.mentionCandidates(
        context,
        principal,
        workItemId,
        typeof q === 'string' ? q : '',
        parsed,
      ),
    };
  }

  @Post()
  @RequireCapability('work.update')
  @HttpCode(201)
  // 53-16: an offline replay sends `Idempotency-Key`, so a lost response never writes twice.
  @UseInterceptors(IdempotencyReplayInterceptor)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: CreateCommentBody,
  ): Promise<WorkCommentView> {
    const text = requiredBody(body?.body);
    return this.comments.add(context, principal, workItemId, { body: text });
  }
}

function requiredBody(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: 'must be a non-empty string' },
    ]);
  }
  const text = raw.trim();
  if (text.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` },
    ]);
  }
  return text;
}
