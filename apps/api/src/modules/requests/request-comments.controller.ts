import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUEST_COMMENTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { RequestCommentView, RequestCommentsService } from './request-comments.service.js';

/**
 * x299's HTTP surface — a client request's internal comment thread (Requests module 11).
 *
 * A sub-resource of the request, the way `POST :clientRequestId/transitions` is: the parent id is in
 * the path, and the service resolves it tenant-scoped before it authorizes or writes. This
 * controller reads no `organizationId` from anywhere — `TenantContextGuard` built the
 * `TenantContext` from a membership row, and there is no field on the body below for a caller to
 * supply one.
 *
 * Every route is behind `client_request.triage`, REQ-001's internal-only triage capability (reused,
 * so this slice needs no `capabilities.ts` edit): a client principal never reaches these paths, and
 * a role without the capability is a 403 before the method runs. The row-level decision — may this
 * principal triage *this* request, given its project — is the service's, against the resolved
 * request. Comments are internal-only and never projected to any client or portal read path.
 */

/** `request_comments.body` is `TEXT`; this bounds a single comment to a sane maximum. */
const MAX_BODY_LENGTH = 5000;

interface CreateCommentBody {
  readonly body?: unknown;
  readonly parentId?: unknown;
}

@Controller('v1/organizations/:orgSlug/client-requests/:clientRequestId/comments')
export class RequestCommentsController {
  constructor(
    @Inject(REQUEST_COMMENTS_SERVICE) private readonly comments: RequestCommentsService,
  ) {}

  @Get()
  @RequireCapability('client_request.triage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
  ): Promise<{ readonly comments: readonly RequestCommentView[] }> {
    return { comments: await this.comments.list(context, principal, clientRequestId) };
  }

  @Post()
  @RequireCapability('client_request.triage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Body() body: CreateCommentBody,
  ): Promise<RequestCommentView> {
    const text = requiredBody(body?.body);
    const parentId = optionalParentId(body?.parentId);
    return this.comments.add(context, principal, clientRequestId, {
      body: text,
      ...(parentId === undefined ? {} : { parentId }),
    });
  }

  @Delete(':commentId')
  @RequireCapability('client_request.triage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('clientRequestId') clientRequestId: string,
    @Param('commentId') commentId: string,
  ): Promise<void> {
    await this.comments.remove(context, principal, clientRequestId, commentId);
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

function optionalParentId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'parentId', message: 'must be a comment id' },
    ]);
  }
  return raw;
}
