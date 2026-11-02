import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { TENANT_DATABASE, WORK_ITEMS_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkKeysService } from './work-keys.service.js';
import type { CodeLinkView } from './work-keys.service.js';

/**
 * R16-e (54-10 GitHub Phase 0) — work keys and code links.
 *
 * - `PUT    …/projects/:projectId/work-key-prefix` (`project.manage`) — set the prefix, backfill.
 * - `GET    …/work-items/:workItemId/code-links` (`work.read`) — the item's key and its links.
 * - `DELETE …/work-items/:workItemId/code-links/:linkId` (`work.update`) — remove one link.
 *
 * The service resolves tenant-scoped first and authorizes again with the real `authorize()`.
 */
@Controller('v1/organizations/:orgSlug')
export class WorkKeysController {
  private readonly service: WorkKeysService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Inject(WORK_ITEMS_REPOSITORY) workItems: WorkItemsRepository,
  ) {
    this.service = new WorkKeysService(database, workItems);
  }

  @Put('projects/:projectId/work-key-prefix')
  @RequireCapability('project.manage')
  @HttpCode(200)
  setPrefix(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: { readonly prefix?: unknown } | undefined,
  ): Promise<{ readonly projectId: string; readonly prefix: string; readonly keyed: number }> {
    return this.service.setPrefix(context, principal, projectId, body?.prefix);
  }

  @Get('work-items/:workItemId/code-links')
  @RequireCapability('work.read')
  listLinks(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly workKey: string | null; readonly links: readonly CodeLinkView[] }> {
    return this.service.listLinks(context, principal, workItemId);
  }

  @Delete('work-items/:workItemId/code-links/:linkId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async removeLink(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    await this.service.removeLink(context, principal, workItemId, linkId);
  }
}
