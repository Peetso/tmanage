import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { WORK_ITEM_RECURRENCE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  NextOccurrenceView,
  WorkItemRecurrenceService,
  WorkItemRecurrenceView,
} from './item-recurrence.service.js';

/**
 * x257's HTTP surface — a work item's recurrence rule (Work module 7).
 *
 * The rule is a sub-resource of a work item (`…/work-items/:workItemId/recurrence`): the parent id
 * is in the path, and the service resolves it tenant-scoped before it authorizes or writes. The
 * capability gate is coarse (`work.read` to read, `work.update` to set / clear / generate-next); the
 * row-level decision is the service's, against the resolved parent. `generate-next` computes the
 * next occurrence in-app and returns it — it writes no work item.
 */

interface SetRecurrenceBody {
  readonly freq?: unknown;
  readonly interval?: unknown;
  readonly until?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class WorkItemRecurrenceController {
  constructor(
    @Inject(WORK_ITEM_RECURRENCE_SERVICE) private readonly recurrence: WorkItemRecurrenceService,
  ) {}

  @Get('work-items/:workItemId/recurrence')
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly recurrence: WorkItemRecurrenceView | null }> {
    return { recurrence: await this.recurrence.get(context, principal, workItemId) };
  }

  @Put('work-items/:workItemId/recurrence')
  @RequireCapability('work.update')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: SetRecurrenceBody,
  ): Promise<WorkItemRecurrenceView> {
    return this.recurrence.set(context, principal, workItemId, {
      freq: body?.freq as string,
      interval: body?.interval as number,
      until: (body?.until ?? null) as string | null,
    });
  }

  @Delete('work-items/:workItemId/recurrence')
  @RequireCapability('work.update')
  @HttpCode(204)
  async clear(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<void> {
    await this.recurrence.clear(context, principal, workItemId);
  }

  @Post('work-items/:workItemId/recurrence/generate-next')
  @RequireCapability('work.update')
  async generateNext(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<NextOccurrenceView> {
    return this.recurrence.generateNext(context, principal, workItemId, new Date());
  }
}
