import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
} from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ChannelLinksRepository } from './channel-links.repository.js';
import { ChannelLinksService } from './channel-links.service.js';
import type {
  ChannelLinkView,
  ChannelLinksDeps,
  CreateChannelLinkBody,
} from './channel-links.service.js';

/** Nest token for the service's optional dependencies (tests inject a cipher and a resolver). */
export const CHANNEL_LINKS_DEPS = Symbol('tmanage.automations.channelLinksDeps');

/**
 * R15-c (54-05 Slack + 54-06 Teams, Phase 0) — pasted incoming-webhook channel links. All routes
 * `org.manage`, re-checked with the real `authorize()`:
 *
 * - `POST   …/integrations/:kind/channel-links` — paste a Slack / Teams URL, pick events + locale.
 * - `GET    …/integrations/channel-links` — list (`urlHost` only, never the URL).
 * - `DELETE …/integrations/channel-links/:id` — remove (its post ledger goes with it).
 * - `POST   …/integrations/channel-links/:id/test` — stage one test post (one a minute per link).
 * - `POST   …/integrations/channel-links/:id/resume` — clear the breaker after a re-resolve.
 */
@Controller('v1/organizations/:orgSlug/integrations')
export class ChannelLinksController {
  private readonly service: ChannelLinksService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() @Inject(CHANNEL_LINKS_DEPS) deps: ChannelLinksDeps = {},
  ) {
    this.service = new ChannelLinksService(database, new ChannelLinksRepository(), deps);
  }

  @Get('channel-links')
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly links: readonly ChannelLinkView[] }> {
    requireOrgManage(principal, context);
    return { links: await this.service.list(context) };
  }

  @Post(':kind/channel-links')
  @RequireCapability('org.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('kind') kind: string,
    @Body() body: CreateChannelLinkBody,
  ): Promise<ChannelLinkView> {
    requireOrgManage(principal, context);
    return this.service.create(context, kind, body);
  }

  @Delete('channel-links/:id')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    requireOrgManage(principal, context);
    await this.service.remove(context, id);
  }

  @Post('channel-links/:id/test')
  @RequireCapability('org.manage')
  @HttpCode(202)
  async test(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<{ readonly staged: true }> {
    requireOrgManage(principal, context);
    return this.service.test(context, id);
  }

  @Post('channel-links/:id/resume')
  @RequireCapability('org.manage')
  @HttpCode(200)
  async resume(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<ChannelLinkView> {
    requireOrgManage(principal, context);
    return this.service.resume(context, id);
  }
}

/** The belt-and-braces half of the route's `CapabilityGuard`: a refusal is a plain 403. */
function requireOrgManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'channel_link_manage_denied',
    );
  }
}
