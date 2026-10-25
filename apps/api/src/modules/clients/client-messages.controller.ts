import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { CLIENT_MESSAGES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_CLIENT_MESSAGE_BODY_LENGTH,
  MAX_CLIENT_MESSAGE_SUBJECT_LENGTH,
  type AdminClientMessageView,
  type ClientMessageView,
  type ClientMessagesService,
} from './client-messages.service.js';

/**
 * SEC / Client portal messages (x322, module "Client portal") — the HTTP surface for a message a
 * client contact posts to the studio from the portal.
 *
 * One controller on the `/portal/messages` path, three routes, two ceilings:
 *
 * - `POST` and `GET` (own thread) behind `client_projection.read` — the client half. The scope is
 *   the caller's own client organization, taken from the session, never this request; there is no
 *   body or query field for a caller to name a scope, so a client can only ever reach their own
 *   thread.
 * - `GET admin` behind `client_member.manage` — the staff half. The built-in `client_admin` role
 *   holds `client_member.manage` (for inviting its own client people), so `CapabilityGuard` lets a
 *   client admin through; the service then authorizes the capability at audience `internal`, which
 *   refuses every client principal with a 404 (audit F02). It resolves the named
 *   `clientOrganizationId` inside the acting tenant first, so a cross-tenant id is a 404 with no read.
 *
 * The organization slug is in the path; the `TenantContext` is built from the authenticated
 * membership, never from the URL or a body field.
 */

interface PostMessageBody {
  readonly subject?: unknown;
  readonly body?: unknown;
}

function requiredText(raw: unknown, field: string, max: number): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  const text = raw.trim();
  if (text.length > max) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: `must be ${max} characters or fewer` },
    ]);
  }
  return text;
}

@Controller('v1/organizations/:orgSlug/portal/messages')
export class PortalClientMessagesController {
  constructor(@Inject(CLIENT_MESSAGES_SERVICE) private readonly messages: ClientMessagesService) {}

  /**
   * Post a message from the portal. `client_projection.read`; the tenant, the client-org scope and
   * the author come from the session, never the body.
   */
  @Post()
  @RequireCapability('client_projection.read')
  @HttpCode(201)
  async post(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: PostMessageBody,
  ): Promise<ClientMessageView> {
    const subject = requiredText(body?.subject, 'subject', MAX_CLIENT_MESSAGE_SUBJECT_LENGTH);
    const text = requiredText(body?.body, 'body', MAX_CLIENT_MESSAGE_BODY_LENGTH);
    return this.messages.post(context, principal, { subject, body: text });
  }

  /** The caller's own message thread. `client_projection.read`. */
  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly messages: readonly ClientMessageView[] }> {
    return { messages: await this.messages.listOwnThread(context, principal) };
  }

  /**
   * The inbound messages for one client organization — staff read. `client_member.manage`, and the
   * service refuses any client principal (audience `internal`). The `clientOrganizationId` is
   * resolved tenant-scoped before the read.
   */
  @Get('admin')
  @RequireCapability('client_member.manage')
  async listForAdmin(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('clientOrganizationId') clientOrganizationId?: string,
  ): Promise<{ readonly messages: readonly AdminClientMessageView[] }> {
    if (typeof clientOrganizationId !== 'string' || clientOrganizationId.trim() === '') {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'clientOrganizationId', message: 'must be a string' },
      ]);
    }
    return { messages: await this.messages.listForAdmin(context, principal, clientOrganizationId) };
  }
}
