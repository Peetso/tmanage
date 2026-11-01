import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { GroupInvitesService } from './group-invites.service.js';
import type { GroupInvitePreview } from './group-settings.service.js';

/** R7 slice 3: the token `ConversationGroupModule` provides `GroupInvitesService` under. */
export const GROUP_INVITES_SERVICE = Symbol.for('tmanage.GroupInvitesService');

/** A minted token is 43 url-safe base64 characters; anything else cannot be one. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * R7 slice 3 — a group invite link, opened by a team member of the same company: a preview (name,
 * photo, member count) and the join. Both behind `conversation.read`, which no client role holds,
 * and the service refuses any principal that is not internal as a second guard.
 */
@Controller('v1/organizations/:orgSlug/chat/invites')
export class GroupInvitesController {
  constructor(@Inject(GROUP_INVITES_SERVICE) private readonly invites: GroupInvitesService) {}

  @Get(':token')
  @RequireCapability('conversation.read')
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('token') token: string,
  ): Promise<GroupInvitePreview> {
    return this.invites.preview(context, principal, requireToken(token));
  }

  @Post(':token/join')
  @RequireCapability('conversation.read')
  @HttpCode(200)
  async join(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('token') token: string,
  ): Promise<{ readonly conversationId: string }> {
    return this.invites.join(context, principal, requireToken(token));
  }
}

function requireToken(token: string): string {
  if (!TOKEN.test(token)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  return token;
}
