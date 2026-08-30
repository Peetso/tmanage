import { Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { signRealtimeTicket } from '@tmanage/domain/realtime-ticket';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/**
 * RT-001's API-side surface: the ticket mint, and nothing else.
 *
 * `13-ENGINEERING` §6: "Socket authenticates short-lived ticket." The socket server lives
 * in the worker — the process that already consumes the events it fans out — so the API's
 * whole realtime job is to convert a session it has proved into a claim the socket can
 * verify without a database: organization, user, expiry, HMAC-signed with a key derived
 * from the session secret (`@tmanage/domain/realtime-ticket` says why derivation beats a
 * second secret).
 *
 * `conversation.read` is the capability, because conversations are the one resource family
 * the first half serves; a role that cannot read any channel has nothing a socket could
 * ever send it. The ticket still confers nothing by itself — every subscription is checked
 * against current rows at the socket.
 */
@Controller('v1/organizations/:orgSlug/realtime')
export class RealtimeController {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  @Post('tickets')
  @RequireCapability('conversation.read')
  @HttpCode(201)
  mint(@Ctx() context: TenantContext): { readonly ticket: string; readonly expiresAt: string } {
    const expiresAt = Date.now() + this.config.realtimeTicketTtlSeconds * 1000;
    return {
      ticket: signRealtimeTicket(
        {
          organizationId: context.organizationId,
          userId: context.userId,
          expiresAt,
        },
        this.config.sessionSecret,
      ),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
}
