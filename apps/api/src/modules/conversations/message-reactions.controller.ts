import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MESSAGE_REACTIONS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  MessageReactionsService,
  MessageReactionTallyView,
} from './message-reactions.service.js';

/**
 * x246 message reactions — CH-07 "Message actions"'s HTTP surface.
 *
 * Mounted under the organization slug like every other route (see `ConversationsController`'s
 * note): the slug is what `TenantContextGuard` resolves the tenant from, and the reaction paths
 * hang off a message inside a conversation.
 *
 * - **PUT** adds the acting member's reaction and answers 200 with the message's tally. A PUT
 *   because the operation is idempotent by design — adding a reaction one already holds is a
 *   no-op — and idempotency is what PUT means.
 * - **DELETE** removes the acting member's reaction and answers 204, idempotently.
 * - **GET** reads the tally.
 *
 * The capability sits on the route: `conversation.write` to add or remove, `conversation.read`
 * to read. The service applies the second, narrowing conversation-membership gate and resolves
 * the message before either can leak whether it exists.
 */

interface PutReactionBody {
  readonly emoji?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class MessageReactionsController {
  constructor(
    @Inject(MESSAGE_REACTIONS_SERVICE) private readonly reactions: MessageReactionsService,
  ) {}

  @Put('conversations/:conversationId/messages/:messageId/reactions')
  @RequireCapability('conversation.write')
  @HttpCode(200)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: PutReactionBody,
  ): Promise<MessageReactionTallyView> {
    const emoji = typeof body?.emoji === 'string' ? body.emoji : undefined;
    if (!emoji) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'emoji', message: 'must be a string' },
      ]);
    }
    return this.reactions.add(context, principal, conversationId, messageId, emoji);
  }

  @Delete('conversations/:conversationId/messages/:messageId/reactions/:emoji')
  @RequireCapability('conversation.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<void> {
    await this.reactions.remove(context, principal, conversationId, messageId, emoji);
  }

  @Get('conversations/:conversationId/messages/:messageId/reactions')
  @RequireCapability('conversation.read')
  async tally(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<MessageReactionTallyView> {
    return this.reactions.tally(context, principal, conversationId, messageId);
  }
}
