import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { CONVERSATION_READ_STATE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ConversationReadStateService } from './read-state.service.js';
import type { MessageReceiptsView } from './message-receipts.repository.js';

/**
 * R7 receipts (F4) — "Delivered to / Read by" for one message, for the message info sheet.
 * Behind `conversation.read` and the same reach rule as the read-state routes: a conversation
 * the caller cannot reach, or a message from another conversation, is a 404.
 */
@Controller('v1/organizations/:orgSlug')
export class MessageReceiptsController {
  constructor(
    @Inject(CONVERSATION_READ_STATE_SERVICE)
    private readonly readState: ConversationReadStateService,
  ) {}

  @Get('conversations/:conversationId/messages/:messageId/receipts')
  @RequireCapability('conversation.read')
  receipts(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ): Promise<MessageReceiptsView> {
    return this.readState.receipts(context, principal, conversationId, messageId);
  }
}
