import { Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { WORK_WATCHERS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ItemWatcherView, WorkWatchersService } from './watchers.service.js';

/**
 * x232's HTTP surface — a work item's watchers / subscribers (Work module 7).
 *
 * A sub-resource of the work item, the way `:workItemId/comments` and `:workItemId/checklist` are:
 * the parent id is in the path, and the service resolves it tenant-scoped before it authorizes or
 * writes. This controller reads no `organizationId` from anywhere — `TenantContextGuard` built the
 * `TenantContext` from a membership row.
 *
 * The gate is `work.read`: a member who may read the item may watch it. The row-level decision —
 * may this principal see *this* item — is the service's, against the resolved parent. A caller
 * watches only themselves; there is no route to subscribe anyone else. `PUT` is idempotent (the
 * unique key), so a repeat is the same 200 and the same row; `DELETE` is idempotent too and
 * answers 204 whether or not a watch was present. No notification is dispatched here.
 */
@Controller('v1/organizations/:orgSlug/work-items/:workItemId/watchers')
export class WorkWatchersController {
  constructor(@Inject(WORK_WATCHERS_SERVICE) private readonly watchers: WorkWatchersService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly watchers: readonly ItemWatcherView[] }> {
    return { watchers: await this.watchers.list(context, principal, workItemId) };
  }

  @Put()
  @RequireCapability('work.read')
  async subscribe(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<ItemWatcherView> {
    return this.watchers.subscribe(context, principal, workItemId);
  }

  @Delete()
  @RequireCapability('work.read')
  @HttpCode(204)
  async unsubscribe(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<void> {
    await this.watchers.unsubscribe(context, principal, workItemId);
  }
}
