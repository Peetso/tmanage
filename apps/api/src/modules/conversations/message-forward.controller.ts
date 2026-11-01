import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { MessageForwardService } from './message-forward.service.js';
import type { ForwardResultView } from './message-forward.service.js';

interface ForwardBody {
  readonly targetConversationIds?: unknown;
}

/**
 * R7 slice 4 — forward a message. A forward writes, so `conversation.write` is the route's ceiling;
 * the source is read through the read gate and each target is posted through
 * `ConversationsService.postMessage`, whose own write gate decides.
 * Answers 200 with the targets that received the copy and those that refused it.
 */
@Controller('v1/organizations/:orgSlug')
export class MessageForwardController {
  constructor(@Inject(MessageForwardService) private readonly forwards: MessageForwardService) {}

  @Post('conversations/:conversationId/messages/:messageId/forward')
  @RequireCapability('conversation.write')
  @HttpCode(200)
  async forward(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: ForwardBody,
  ): Promise<ForwardResultView> {
    const ids = body?.targetConversationIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'targetConversationIds', message: 'must be a list of conversation ids' },
      ]);
    }
    return this.forwards.forward(context, principal, conversationId, messageId, ids as string[]);
  }
}
