import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Redirect,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Principal } from '@tmanage/domain';
import {
  Ctx,
  CurrentPrincipal,
  NoTenant,
  Public,
  RequireCapability,
} from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import {
  expiredFlowCookie,
  flowCookie,
  isWorkspaceSlug,
  readFlowCookie,
  type CookieReply,
  type CookieRequest,
} from '../../common/http/oauth-flow.js';
import {
  FIGMA_FLOW_COOKIE,
  figmaCallbackTarget,
  figmaReturnTo,
  openFigmaFlow,
  sealFigmaFlow,
} from './figma-oauth.js';
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
  PagesInput,
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

/** FIX4 item 6: what the one-click Connect routes need from the API config. */
export const FIGMA_HTTP_OPTIONS = Symbol.for('tmanage.FigmaHttpOptions');

export interface FigmaHttpOptions {
  readonly sessionSecret: string;
  readonly secureCookies: boolean;
  readonly webPublicUrl: string;
}

@Controller('v1/organizations/:orgSlug/figma')
export class FigmaController {
  constructor(
    @Inject(FIGMA_SERVICE) private readonly figma: FigmaService,
    @Inject(FIGMA_HTTP_OPTIONS) private readonly options: FigmaHttpOptions,
  ) {}

  /**
   * FIX4 item 6. One-click Connect: Figma's consent address; the signed flow cookie (state, this
   * person, this workspace) rides along for the return. 409 when the server has no Figma app.
   */
  @Post('connection/start')
  @RequireCapability('work.read')
  @HttpCode(200)
  start(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('orgSlug') orgSlug: string,
    @Body() body: { readonly returnTo?: unknown } | undefined,
    @Res({ passthrough: true }) reply: CookieReply,
  ): { readonly url: string } {
    if (!isWorkspaceSlug(orgSlug)) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'orgSlug', message: 'is not a workspace address' },
      ]);
    }
    const { url, flow } = this.figma.startConnect(
      context,
      principal,
      orgSlug,
      figmaReturnTo(body?.returnTo),
    );
    reply.header(
      'set-cookie',
      flowCookie(
        FIGMA_FLOW_COOKIE,
        sealFigmaFlow(flow, this.options.sessionSecret),
        this.options.secureCookies,
      ),
    );
    return { url };
  }

  /** FIX4 item 6. Finish one-click Connect with the `code` and `state` Figma sent back. */
  @Post('connection/complete')
  @RequireCapability('work.read')
  @HttpCode(200)
  async complete(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly code?: unknown; readonly state?: unknown } | undefined,
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ): Promise<FigmaConnectionView> {
    const flow = openFigmaFlow(
      readFlowCookie(request, FIGMA_FLOW_COOKIE),
      this.options.sessionSecret,
    );
    // The flow is single-use whatever happens next.
    reply.header('set-cookie', expiredFlowCookie(FIGMA_FLOW_COOKIE, this.options.secureCookies));
    return this.figma.completeConnect(context, principal, flow, {
      code: body?.code,
      state: body?.state,
    });
  }

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

  /**
   * "Refresh from Figma": the file is read again (new, renamed, moved and removed frames) and
   * every captured frame is drawn again.
   */
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

  /** Which pages to capture when the file has more frames than one link captures. */
  @Put('links/:linkId/pages')
  @RequireCapability('file.upload')
  @HttpCode(200)
  async pages(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('linkId') linkId: string,
    @Body() body: PagesInput | undefined,
  ): Promise<FigmaLinkView> {
    return this.figma.setPages(context, principal, linkId, body ?? {});
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

  /** A small picture of the frame's snapshot (the whole-page view). */
  @Get('frames/:frameId/thumb')
  @RequireCapability('file.download')
  async thumb(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.figma.thumb(context, principal, 'internal', frameId);
    return respondWithSnapshot(content, reply);
  }

  /** The frame rendered sharper for zooming in (made once, then stored; rate-limited). */
  @Get('frames/:frameId/render')
  @RequireCapability('file.download')
  async render(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('frameId') frameId: string,
    @Res({ passthrough: true }) reply: HeaderWriter,
  ): Promise<StreamableFile> {
    const content = await this.figma.render(context, principal, 'internal', frameId);
    return respondWithSnapshot(content, reply);
  }
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/figma')
export class ProjectFigmaController {
  constructor(@Inject(FIGMA_SERVICE) private readonly figma: FigmaService) {}

  /** Read a pasted Figma link with the caller's token: the file's name, pages and frames. */
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

  /** Attach the whole file (or only some frames) to the project, optionally to one item. */
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

/**
 * FIX4 item 6. Figma's redirect after consent. Public and tenant-less because Figma makes this
 * request; it only forwards `code` and `state` in the fragment to the Integrations page, which
 * completes under the person's own session.
 */
@Controller('v1/integrations/figma')
export class FigmaCallbackController {
  constructor(@Inject(FIGMA_HTTP_OPTIONS) private readonly options: FigmaHttpOptions) {}

  @Get('callback')
  @Public()
  @NoTenant()
  @Redirect()
  callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Req() request: CookieRequest,
  ): { readonly url: string; readonly statusCode: number } {
    return {
      url: figmaCallbackTarget(
        this.options,
        readFlowCookie(request, FIGMA_FLOW_COOKIE),
        code,
        state,
        error,
      ),
      statusCode: 302,
    };
  }
}
