import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { THREAD_REPLIES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ThreadRepliesService,
  ThreadReplyView,
  ThreadView,
} from './thread-replies.service.js';

interface AppendThreadReplyBody {
  readonly body?: unknown;
}

/**
 * x249's HTTP surface — a message's thread replies (planning ref CH-05 "Thread").
 *
 * `ConversationsController`'s shape and the same rule about what it does not do: it reads no
 * `organizationId` from anywhere, because `TenantContextGuard` built the context from a
 * membership row. Two routes, both on the root message: `POST …/thread` appends a reply behind
 * `conversation.write`, `GET …/thread` reads the ordered replies and their count behind
 * `conversation.read`. The service resolves the conversation and root message before the
 * relation gate, so a thread that is not there — or not this caller's to reach — is a 404.
 *
 * A reply is an append: 201, no version, no dedupe key. There is no edit or delete route,
 * because the table has no edit or delete path.
 */
@Controller('v1/organizations/:orgSlug')
export class ThreadRepliesController {
  constructor(@Inject(THREAD_REPLIES_SERVICE) private readonly threads: ThreadRepliesService) {}

  @Get('conversations/:conversationId/messages/:messageId/thread')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<ThreadView> {
    return this.threads.listReplies(context, principal, conversationId, messageId);
  }

  @Post('conversations/:conversationId/messages/:messageId/thread')
  @RequireCapability('conversation.write')
  @HttpCode(201)
  async append(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: AppendThreadReplyBody,
  ): Promise<ThreadReplyView> {
    const details: { field: string; message: string }[] = [];
    const text = replyBody(body?.body, details);
    if (details.length > 0 || text === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.threads.appendReply(context, principal, conversationId, messageId, { body: text });
  }
}

/**
 * `messages.body` reasoning, restated: `body` is `TEXT`, the limit is in characters and set
 * well under the byte ceiling, and an empty reply is refused — a thread full of blank lines is
 * not a feature.
 */
const MAX_BODY_LENGTH = 16_000;

function replyBody(
  value: unknown,
  details: { field: string; message: string }[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'body', message: 'must be a string' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'body', message: 'must be a non-empty string' });
    return undefined;
  }
  if (trimmed.length > MAX_BODY_LENGTH) {
    details.push({ field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` });
    return undefined;
  }
  return trimmed;
}
