import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ApplyTemplateResultView,
  ChecklistTemplateView,
  WorkChecklistTemplatesService,
} from './checklist-templates.service.js';

/**
 * x292's HTTP surface — reusable work-item checklist templates (Work module 7).
 *
 * Two shapes of resource on one controller. Template *definitions* are org-scoped
 * (`…/work/checklist-templates`); *applying* a template is a sub-resource action on a work item
 * (`…/work-items/:workItemId/apply-checklist-template/:templateId`), the way the checklist and labels
 * are — the parent id is in the path, and the service resolves it tenant-scoped before it authorizes
 * or writes. The capability gate is coarse (`work.read` to list, `work.update` to define / delete /
 * apply); the org-level and row-level decisions are the service's.
 *
 * This controller reads no `organizationId` from anywhere — `TenantContextGuard` built the
 * `TenantContext` from a membership row, and no body field below carries one.
 */

/** DI token, defined here (via the global registry) so x292 need not touch the shared tokens file. */
export const WORK_CHECKLIST_TEMPLATES_SERVICE = Symbol.for('tmanage.WorkChecklistTemplatesService');

interface DefineTemplateBody {
  readonly name?: unknown;
  readonly labels?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class WorkChecklistTemplatesController {
  constructor(
    @Inject(WORK_CHECKLIST_TEMPLATES_SERVICE)
    private readonly templates: WorkChecklistTemplatesService,
  ) {}

  @Get('work/checklist-templates')
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly templates: readonly ChecklistTemplateView[] }> {
    return { templates: await this.templates.list(context, principal) };
  }

  @Post('work/checklist-templates')
  @RequireCapability('work.update')
  @HttpCode(201)
  async define(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: DefineTemplateBody,
  ): Promise<ChecklistTemplateView> {
    return this.templates.define(context, principal, {
      name: body?.name as string,
      labels: body?.labels as string[],
    });
  }

  @Delete('work/checklist-templates/:templateId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('templateId') templateId: string,
  ): Promise<void> {
    await this.templates.delete(context, principal, templateId);
  }

  @Post('work-items/:workItemId/apply-checklist-template/:templateId')
  @RequireCapability('work.update')
  async apply(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('templateId') templateId: string,
  ): Promise<ApplyTemplateResultView> {
    return this.templates.apply(context, principal, workItemId, templateId);
  }
}
