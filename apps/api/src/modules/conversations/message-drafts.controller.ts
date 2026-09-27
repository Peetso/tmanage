import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MESSAGE_DRAFTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { MessageDraftsService, MessageDraftView } from './message-drafts.service.js';

/**
 * x251's HTTP surface — a member's unsent composer draft for one conversation.
 *
 * `ConversationsController`'s shape and the same rule: it reads no `organizationId` from
 * anywhere, and it names no membership — the draft is always the acting principal's, keyed in
 * the service by `context.membershipId`. All three routes sit behind `conversation.write`,
 * because a draft is the composer's own state and there is nothing to draft in a channel you
 * cannot post to. The conversation is resolved and the write gate applied in the service before
 * a draft is read or written, so an unknown or cross-tenant id is a 404, not a 403.
 *
 * The one thing this controller decides is the body: a draft's `body` is a string bounded to
 * {@link MAX_DRAFT_LENGTH}, and over the cap is a 400 here — before the service runs, so nothing
 * is upserted. The bound matches `messages.body`'s: a draft that could not be sent as a message
 * is not a draft worth keeping.
 */

/**
 * `messages.body` is `TEXT`; the composer bounds a post at 16,000 characters (see
 * `ConversationsController`), and a draft of the same text is bounded the same way.
 */
const MAX_DRAFT_LENGTH = 16_000;

interface SaveDraftBody {
  readonly body?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class MessageDraftsController {
  constructor(@Inject(MESSAGE_DRAFTS_SERVICE) private readonly drafts: MessageDraftsService) {}

  @Get('conversations/:conversationId/draft')
  @RequireCapability('conversation.write')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<MessageDraftView> {
    return this.drafts.get(context, principal, conversationId);
  }

  @Put('conversations/:conversationId/draft')
  @RequireCapability('conversation.write')
  async save(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: SaveDraftBody,
  ): Promise<MessageDraftView> {
    const draft = draftBody(body?.body);
    return this.drafts.save(context, principal, conversationId, draft);
  }

  @Delete('conversations/:conversationId/draft')
  @RequireCapability('conversation.write')
  @HttpCode(204)
  async clear(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<void> {
    await this.drafts.clear(context, principal, conversationId);
  }
}

/**
 * A draft body: a string, bounded. Not trimmed and not refused when empty — a composer draft is
 * whatever the member has typed so far, and an empty string is a legitimate intermediate state
 * (a member who has cleared the box but not yet navigated away). Over the cap is the one
 * refusal, and it is a 400 that names the field.
 */
function draftBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: 'must be a string' },
    ]);
  }
  if (value.length > MAX_DRAFT_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: `must be ${MAX_DRAFT_LENGTH} characters or fewer` },
    ]);
  }
  return value;
}
