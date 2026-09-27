import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_LABELS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ItemLabelView, WorkLabelView, WorkLabelsService } from './work-labels.service.js';

/**
 * x233's HTTP surface — work item labels / tags (Work module 7).
 *
 * Two shapes of resource on one controller. Label *definitions* are org-scoped
 * (`…/work/labels`); a label *assignment* is a sub-resource of a work item
 * (`…/work-items/:workItemId/labels`), the way the checklist and comments are — the parent id is in
 * the path, and the service resolves it tenant-scoped before it authorizes or writes. The capability
 * gate is coarse (`work.read` to list, `work.update` to define / assign / remove); the row-level
 * decision is the service's, against the resolved parent.
 */

interface DefineLabelBody {
  readonly name?: unknown;
  readonly color?: unknown;
}

interface AssignLabelBody {
  readonly labelId?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class WorkLabelsController {
  constructor(@Inject(WORK_LABELS_SERVICE) private readonly labels: WorkLabelsService) {}

  @Get('work/labels')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly labels: readonly WorkLabelView[] }> {
    return { labels: await this.labels.listDefinitions(context) };
  }

  @Post('work/labels')
  @RequireCapability('work.update')
  @HttpCode(201)
  async define(
    @Ctx() context: TenantContext,
    @Body() body: DefineLabelBody,
  ): Promise<WorkLabelView> {
    return this.labels.define(context, {
      name: body?.name as string,
      color: body?.color as string,
    });
  }

  @Get('work-items/:workItemId/labels')
  @RequireCapability('work.read')
  async listForItem(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly labels: readonly ItemLabelView[] }> {
    return { labels: await this.labels.listForItem(context, principal, workItemId) };
  }

  @Put('work-items/:workItemId/labels')
  @RequireCapability('work.update')
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: AssignLabelBody,
  ): Promise<ItemLabelView> {
    const labelId = requiredLabelId(body?.labelId);
    return this.labels.assign(context, principal, workItemId, labelId);
  }

  @Delete('work-items/:workItemId/labels/:labelId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('labelId') labelId: string,
  ): Promise<void> {
    await this.labels.remove(context, principal, workItemId, labelId);
  }
}

function requiredLabelId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'labelId', message: 'must be a non-empty string' },
    ]);
  }
  return raw.trim();
}
