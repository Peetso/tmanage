import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { UPDATE_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_UPDATE_COMMENT_BODY_LENGTH,
  type ClientUpdateCommentView,
  type UpdateCommentView,
  type UpdateCommentsService,
} from './update-comments.service.js';

/**
 * SEC / Portal update comments (x203, module 13) — the HTTP surface for a comment thread on a
 * published project update.
 *
 * Two controllers, the x139 milestones shape: the internal one on the `projects` path behind
 * `project.manage` (a client role never holds it, so `CapabilityGuard` refuses a client with 403
 * before the handler runs), and the portal one on `/portal` behind `client_projection.read`. Both
 * share one {@link UpdateCommentsService}, which resolves the update inside the named project and
 * tenant first — a cross-tenant or other-project id is a 404 with no write. Neither controller reads
 * an `organizationId` from anywhere: the `TenantContext` is built from a membership row, and there
 * is no body field for a caller to supply one.
 */

interface PostCommentBody {
  readonly body?: unknown;
}

function requiredBody(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: 'must be a non-empty string' },
    ]);
  }
  const text = raw.trim();
  if (text.length > MAX_UPDATE_COMMENT_BODY_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: `must be ${MAX_UPDATE_COMMENT_BODY_LENGTH} characters or fewer` },
    ]);
  }
  return text;
}

/**
 * The internal comments surface — `project.manage`, on the `projects` path. A client principal never
 * holds `project.manage`, so the guard refuses them here with 403; the service applies the
 * object-level decision (404 for an update/project they cannot manage).
 */
@Controller('v1/organizations/:orgSlug/projects/:projectId/updates/:updateId/comments')
export class ProjectUpdateCommentsController {
  constructor(@Inject(UPDATE_COMMENTS_SERVICE) private readonly comments: UpdateCommentsService) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('updateId') updateId: string,
  ): Promise<{ readonly comments: readonly UpdateCommentView[] }> {
    return { comments: await this.comments.listInternal(context, principal, projectId, updateId) };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('updateId') updateId: string,
    @Body() body: PostCommentBody,
  ): Promise<UpdateCommentView> {
    const text = requiredBody(body?.body);
    return this.comments.post(context, principal, projectId, updateId, { body: text });
  }
}

/**
 * The client comments projection — `client_projection.read`, on the `/portal` path. No staff
 * identity, and 404 (not 403, not an empty list) for a project this client cannot read or an update
 * that is not theirs / not published.
 */
@Controller('v1/organizations/:orgSlug/portal/projects/:projectId/updates/:updateId/comments')
export class PortalUpdateCommentsController {
  constructor(@Inject(UPDATE_COMMENTS_SERVICE) private readonly comments: UpdateCommentsService) {}

  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('updateId') updateId: string,
  ): Promise<{ readonly comments: readonly ClientUpdateCommentView[] }> {
    return { comments: await this.comments.listForClient(context, principal, projectId, updateId) };
  }
}
