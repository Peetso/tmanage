import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { PORTAL_FILE_LIST_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { PortalFileListService, PortalFileView } from './portal-file-list.service.js';

/**
 * FILE-003 · WEB-006 — the client's view of which files a project holds for them.
 *
 * A separate route from the per-file download door (`/portal/files/:fileAssetId/content`): this
 * one lists, that one streams bytes. Both are `file.download`-adjacent client surfaces, but the
 * list needs a project in the path — a client's files are a project's, never the tenant's — so it
 * lives under `/portal/projects/:projectId/files`, beside the updates timeline (CLIENT-003).
 *
 * `client_projection.read` on the route (the capability every client role holds to read the
 * portal); {@link PortalFileListService} then holds the principal to a client, resolves the
 * project relation-scoped before any read, and lists only the request attachments the download
 * door would actually serve to this client organization.
 */
@Controller('v1/organizations/:orgSlug/portal/projects/:projectId/files')
export class PortalFileListController {
  constructor(@Inject(PORTAL_FILE_LIST_SERVICE) private readonly files: PortalFileListService) {}

  @Get()
  @RequireCapability('client_projection.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly files: readonly PortalFileView[] }> {
    return { files: await this.files.listForClient(context, principal, projectId) };
  }
}
