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
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { WORK_ITEM_RECURRENCE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  NextOccurrenceView,
  RecurrencePreviewView,
  SetRecurrenceInput,
  WorkItemRecurrenceService,
  WorkItemRecurrenceView,
} from './item-recurrence.service.js';

/**
 * x257's HTTP surface — a work item's recurrence rule (Work module 7), extended by 53-09.
 *
 * The rule is a sub-resource of a work item (`…/work-items/:workItemId/recurrence`): the parent id
 * is in the path, and the service resolves it tenant-scoped before it authorizes or writes.
 *
 * Capabilities (53-09; no `capabilities.ts` change): `work.read` reads the rule and the preview;
 * `work.update` on the seed item sets / clears / skips / pauses / resumes / ends the series and
 * computes generate-next. Spawning is not a route: the in-process recurrence spawner (a named
 * service entry point, reason `recurrence_spawner`) re-checks that the rule owner still holds
 * `work.create` in the project and pauses the rule if not. Preview and generate-next write nothing.
 */

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
    @Body() body: SetRecurrenceInput,
  ): Promise<WorkItemRecurrenceView> {
    return this.recurrence.set(context, principal, workItemId, body ?? {});
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

  // ---- 53-09 ----

  @Get('work-items/:workItemId/recurrence/preview')
  @RequireCapability('work.read')
  async preview(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Query('count') count?: string,
  ): Promise<RecurrencePreviewView> {
    return this.recurrence.preview(context, principal, workItemId, count);
  }

  /** r46: the next 5 dates of an unsaved rule (the editor's live preview). Writes nothing. */
  @Post('work-items/:workItemId/recurrence/preview')
  @RequireCapability('work.read')
  @HttpCode(200)
  async previewDraft(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: SetRecurrenceInput,
  ): Promise<RecurrencePreviewView> {
    return this.recurrence.previewDraft(context, principal, workItemId, body);
  }

  @Post('work-items/:workItemId/recurrence/skip')
  @RequireCapability('work.update')
  @HttpCode(200)
  async skip(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly occurrenceKey?: unknown },
  ): Promise<{ readonly occurrenceKey: string; readonly status: 'skipped' }> {
    return this.recurrence.skip(context, principal, workItemId, body?.occurrenceKey);
  }

  @Post('work-items/:workItemId/recurrence/pause')
  @RequireCapability('work.update')
  @HttpCode(200)
  async pause(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemRecurrenceView> {
    return this.recurrence.changeStatus(context, principal, workItemId, 'paused');
  }

  @Post('work-items/:workItemId/recurrence/resume')
  @RequireCapability('work.update')
  @HttpCode(200)
  async resume(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemRecurrenceView> {
    return this.recurrence.changeStatus(context, principal, workItemId, 'active');
  }

  @Post('work-items/:workItemId/recurrence/end')
  @RequireCapability('work.update')
  @HttpCode(200)
  async end(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemRecurrenceView> {
    return this.recurrence.changeStatus(context, principal, workItemId, 'ended');
  }
}
