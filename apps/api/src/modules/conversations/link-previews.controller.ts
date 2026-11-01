import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CONVERSATIONS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ConversationsService } from './conversations.service.js';
import { LinkPreviewsRepository } from './link-previews.repository.js';
import type { LinkPreviewView } from './link-previews.repository.js';

/** How many message ids one read may name. */
export const MAX_LINK_PREVIEW_MESSAGE_IDS = 50;

/**
 * R7 slice 5 — `GET …/conversations/:conversationId/link-previews?messageIds=a,b,c`.
 *
 * The rows the worker unfurled (`pending` / `ready` / `failed`) for up to 50 messages of one
 * conversation. Gated as reading the conversation is: `conversation.read` on the ceiling, then
 * `ConversationsService.get`, which applies the relation and membership gate and answers 404 for a
 * conversation the caller cannot reach. Nothing is fetched here — the unfurl is the worker's.
 */
@Controller('v1/organizations/:orgSlug')
export class LinkPreviewsController {
  private readonly previews = new LinkPreviewsRepository();

  constructor(
    @Inject(CONVERSATIONS_SERVICE) private readonly conversations: ConversationsService,
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
  ) {}

  @Get('conversations/:conversationId/link-previews')
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Query('messageIds') messageIds?: unknown,
  ): Promise<{ readonly previews: readonly LinkPreviewView[] }> {
    const ids = [
      ...new Set(
        (typeof messageIds === 'string' ? messageIds : '')
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id !== ''),
      ),
    ];
    if (
      ids.length === 0 ||
      ids.length > MAX_LINK_PREVIEW_MESSAGE_IDS ||
      ids.some((id) => id.length > 36)
    ) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        {
          field: 'messageIds',
          message: `must list 1 to ${MAX_LINK_PREVIEW_MESSAGE_IDS} message ids, comma separated`,
        },
      ]);
    }
    await this.conversations.get(context, principal, conversationId);
    const previews = await this.database.read(context, (runner) =>
      this.previews.listForMessages(runner, context, conversationId, ids),
    );
    return { previews };
  }
}
