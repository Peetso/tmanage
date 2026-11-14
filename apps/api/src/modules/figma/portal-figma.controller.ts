import { Controller, Get, Inject, Param, Query, Res, type StreamableFile } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { HeaderWriter } from '../files/download-response.js';
import { respondWithSnapshot } from './figma.controller.js';
import { FIGMA_SERVICE } from './figma.service.js';
import type { FigmaLinkListView, FigmaLinkView, FigmaService } from './figma.service.js';

/**
 * R4 slice 13 — the client's Figma routes under `/portal`: snapshot mode only. The service
 * refuses any principal that is not a client, shows only `client_visible` links of projects the
 * client's `client_projection.read` reaches, and its view carries no Figma address, live-embed
 * address or attachment target. Swept by the `ClientProjectionInterceptor`.
 */
@Controller('v1/organizations/:orgSlug/portal/figma')
export class PortalFigmaController {
  constructor(@Inject(FIGMA_SERVICE) private readonly figma: FigmaService) {}

  /** Every Figma link shared with this client (the portal's Files page). */
  @Get('links')
  @RequireCapability('client_projection.read')
  async links(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FigmaLinkListView> {
    return this.figma.clientLinks(context, principal);
  }

  @Get('links/:linkId')
  @RequireCapability('client_projection.read')
  async link(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('linkId') linkId: string,
  ): Promise<FigmaLinkView> {
    return this.figma.link(context, principal, 'client', linkId);
  }

  @Get('frames/:frameId/snapshot')
  @RequireCapability('client_projection.read')
  async snapshot(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.figma.snapshot(context, principal, 'client', frameId);
    return respondWithSnapshot(content, reply);
  }

  @Get('frames/:frameId/thumb')
  @RequireCapability('client_projection.read')
  async thumb(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.figma.thumb(context, principal, 'client', frameId);
    return respondWithSnapshot(content, reply);
  }

  /** The sharper render for zooming in, drawn with the team's Figma connection (rate-limited). */
  @Get('frames/:frameId/render')
  @RequireCapability('client_projection.read')
  async render(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.figma.render(context, principal, 'client', frameId);
    return respondWithSnapshot(content, reply);
  }
}

@Controller('v1/organizations/:orgSlug/portal/projects/:projectId/figma')
export class PortalProjectFigmaController {
  constructor(@Inject(FIGMA_SERVICE) private readonly figma: FigmaService) {}

  @Get('links')
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('attachedToType') attachedToType?: string,
    @Query('attachedToId') attachedToId?: string,
  ): Promise<FigmaLinkListView> {
    return this.figma.list(context, principal, 'client', projectId, {
      ...(attachedToType !== undefined ? { attachedToType } : {}),
      ...(attachedToId !== undefined ? { attachedToId } : {}),
    });
  }
}
