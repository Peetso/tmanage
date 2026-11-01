import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { parseUserIds } from './presence.service.js';
import type { PresenceService, PresenceView } from './presence.service.js';

export const PRESENCE_SERVICE = Symbol.for('tmanage.PresenceService');

/**
 * R7 presence routes (F4). `POST presence/heartbeat` — the web calls it every 60 s while the tab
 * is visible; `GET presence?userIds=` — online / last seen for up to 100 people. Both sit behind
 * `conversation.read`: presence exists for chat, and no new capability is invented.
 */
@Controller('v1/organizations/:orgSlug/presence')
export class PresenceController {
  constructor(@Inject(PRESENCE_SERVICE) private readonly service: PresenceService) {}

  @Post('heartbeat')
  @RequireCapability('conversation.read')
  @HttpCode(204)
  async heartbeat(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.service.heartbeat(context, principal.userId);
  }

  @Get()
  @RequireCapability('conversation.read')
  async list(
    @Ctx() context: TenantContext,
    @Query('userIds') userIds: unknown,
  ): Promise<{ readonly people: readonly PresenceView[] }> {
    return { people: await this.service.list(context, parseUserIds(userIds)) };
  }
}
