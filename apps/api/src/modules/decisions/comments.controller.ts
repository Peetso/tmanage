import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { DECISION_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { DecisionCommentView, DecisionCommentsService } from './comments.service.js';

/**
 * x317's HTTP surface — a decision's internal comment thread (Requests, decisions & approvals:
 * decision discussion; 22-SCREEN decision register).
 *
 * A sub-resource of the decision, the way the decision's supersede and lock routes are: the parent
 * id is in the path, and the service resolves it tenant-scoped before it authorizes or writes. This
 * controller reads no `organizationId` from anywhere — `TenantContextGuard` built the
 * `TenantContext` from a membership row.
 *
 * Every route is behind `work.read`: decisions are internal (no client audience ever reaches this
 * path), and reading, commenting on and deleting one's own comment on a decision are all acts an
 * internal member with `work.read` on the project may take. The coarse capability gate here is the
 * ceiling; the resource-scoped decision (relation, and delete-author) is the service's.
 */

/** `decision_comments.body` is `TEXT`; this bounds a single comment to a sane maximum. */
const MAX_BODY_LENGTH = 5000;

interface CreateCommentBody {
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug/decisions/:decisionId/comments')
export class DecisionCommentsController {
  constructor(
    @Inject(DECISION_COMMENTS_SERVICE) private readonly comments: DecisionCommentsService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
  ): Promise<{ readonly comments: readonly DecisionCommentView[] }> {
    return { comments: await this.comments.list(context, principal, decisionId) };
  }

  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Body() body: CreateCommentBody,
  ): Promise<DecisionCommentView> {
    const text = requiredBody(body?.body);
    return this.comments.add(context, principal, decisionId, text);
  }

  @Delete(':commentId')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    await this.comments.remove(context, principal, decisionId, commentId);
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
