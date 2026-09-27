import { Body, Controller, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CONVERSATION_MUTE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ConversationMuteService } from './conversation-mute.service.js';

/**
 * CH-09 — the caller's own mute/unmute state for a conversation, read and replaced (module Chat, x252).
 *
 * ## Own preference only, behind `conversation.read`
 *
 * `PUT .../mute {muted}` and `GET .../mute` both sit behind **`conversation.read`** — the capability
 * `12-PERMISSION-MATRIX` gives every internal role for a channel they can see, and pass-24 forbids
 * editing `capabilities.ts`. Muting is a personal notification preference, not a change to the
 * channel, so it reuses the read capability rather than `conversation.write` (which would wrongly
 * require the stronger grant to silence one's own notifications). The subject is the authenticated
 * `principal`'s membership; the request has no field that could name another member's row. The
 * service resolves the conversation within the tenant and authorizes it before any write, so a
 * conversation in another studio is a 404 and nothing is stored.
 *
 * ## `muted` must be a boolean
 *
 * The body carries exactly `{ muted: boolean }`. A missing or non-boolean `muted` is the client's
 * error to be told about (400), never a state the store should hold — validated here, before the
 * service is called, so a malformed body never reaches a write.
 */

/** What the GET/PUT route exchanges: the caller's mute state, without row identity. */
export interface ConversationMuteView {
  readonly muted: boolean;
}

@Controller('v1/organizations/:orgSlug')
export class ConversationMuteController {
  constructor(@Inject(CONVERSATION_MUTE_SERVICE) private readonly mutes: ConversationMuteService) {}

  @Get('conversations/:conversationId/mute')
  @RequireCapability('conversation.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
  ): Promise<ConversationMuteView> {
    return { muted: await this.mutes.getMute(context, principal, conversationId) };
  }

  @Put('conversations/:conversationId/mute')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  async put(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<ConversationMuteView> {
    const muted = parseMuted(body);
    return { muted: await this.mutes.setMute(context, principal, conversationId, muted) };
  }
}

/** The one field, and it must be a boolean — anything else is a 400 and nothing is written. */
function parseMuted(body: unknown): boolean {
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const muted = value['muted'];
  if (typeof muted !== 'boolean') {
    throw new ApiError(400, 'validation_failed', 'The mute preference is invalid', [
      { field: 'muted', message: 'must be a boolean' },
    ]);
  }
  return muted;
}
