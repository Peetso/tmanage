import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { SANDBOX_CSP } from '../files/download-response.js';
import type { HeaderWriter } from '../files/download-response.js';
import { FIGMA_SERVICE } from './figma.service.js';
import type {
  AttachInput,
  FigmaConnectionView,
  FigmaInspectView,
  FigmaLinkListView,
  FigmaLinkView,
  FigmaRefreshView,
  FigmaService,
  InspectInput,
  SnapshotContent,
} from './figma.service.js';

/**
 * R4 slice 13 — the studio's Figma routes (SPEC R4 §3.3). Like every tenant controller here, none
 * reads an organization from the body, a header or its own `:orgSlug`: the guard built the
 * `TenantContext`. The coarse gates are the route's; the service makes the object decision on the
 * link's project and audience (one 404). The threads on frames are the review module's routes
 * (`figma-review.controller.ts`).
 */

/** A frame snapshot: a TManage-stored PNG, inline, sandboxed, cached privately. */
export function respondWithSnapshot(content: SnapshotContent, reply: HeaderWriter): StreamableFile {
  reply.header('content-type', content.mimeType);
  reply.header('content-length', String(content.sizeBytes));
  reply.header('content-disposition', 'inline');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', SANDBOX_CSP);
  reply.header('cache-control', 'private, max-age=3600');
  return new StreamableFile(content.stream as Readable, {
    type: content.mimeType,
    length: content.sizeBytes,
  });
}

@Controller('v1/organizations/:orgSlug/figma')
export class FigmaController {
  constructor(@Inject(FIGMA_SERVICE) private readonly figma: FigmaService) {}

  /** The caller's own Figma connection (never the token; its last four characters). */
  @Get('connection')
  @RequireCapability('work.read')
  async connection(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FigmaConnectionView> {
    return this.figma.connection(context, principal);
  }

  /** Store (or replace) the caller's personal access token after Figma accepts it. */
  @Post('connection')
  @RequireCapability('work.read')
  @HttpCode(200)
  async connect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { token?: unknown } | undefined,
  ): Promise<FigmaConnectionView> {
    return this.figma.connect(context, principal, body ?? {});
  }

  @Delete('connection')
  @RequireCapability('work.read')
  @HttpCode(200)
  async disconnect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FigmaConnectionView> {
    return this.figma.disconnect(context, principal);
  }

  /** The viewer's manifest: frames, snapshots, live-embed addresses, what the caller may do. */
  @Get('links/:linkId')
  @RequireCapability('file.download')
  async link(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('linkId') linkId: string,
  ): Promise<FigmaLinkView> {
    return this.figma.link(context, principal, 'internal', linkId);
  }

  /** "Refresh snapshots": every frame back in the queue. */
  @Post('links/:linkId/snapshots')
  @RequireCapability('file.upload')
  @HttpCode(202)
  async refresh(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('linkId') linkId: string,
  ): Promise<FigmaRefreshView> {
    return this.figma.refresh(context, principal, linkId);
  }

  @Delete('links/:linkId')
  @RequireCapability('file.upload')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    await this.figma.remove(context, principal, linkId);
  }

  /** A frame's stored PNG snapshot. */
  @Get('frames/:frameId/snapshot')
  @RequireCapability('file.download')
  async snapshot(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.figma.snapshot(context, principal, 'internal', frameId);
    return respondWithSnapshot(content, reply);
  }
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/figma')
export class ProjectFigmaController {
  constructor(@Inject(FIGMA_SERVICE) private readonly figma: FigmaService) {}

  /** Read a pasted Figma link with the caller's token: the file's name and its frames. */
  @Post('inspect')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async inspect(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: InspectInput | undefined,
  ): Promise<FigmaInspectView> {
    return this.figma.inspect(context, principal, projectId, body ?? {});
  }

  /** Attach the picked frames (20 at most) to the project, optionally to one item. */
  @Post('links')
  @RequireCapability('file.upload')
  @HttpCode(201)
  async attach(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: AttachInput | undefined,
  ): Promise<FigmaLinkView> {
    return this.figma.attach(context, principal, projectId, body ?? {});
  }

  /** The project's Figma links, or those attached to one work item, version or request. */
  @Get('links')
  @RequireCapability('file.download')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('attachedToType') attachedToType?: string,
    @Query('attachedToId') attachedToId?: string,
  ): Promise<FigmaLinkListView> {
    return this.figma.list(context, principal, 'internal', projectId, {
      ...(attachedToType !== undefined ? { attachedToType } : {}),
      ...(attachedToId !== undefined ? { attachedToId } : {}),
    });
  }
}
