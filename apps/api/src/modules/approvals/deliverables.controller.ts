import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ApproverView,
  DeliverableDetailView,
  DeliverableVersionView,
  DeliverableView,
  DeliverablesService,
  SendForApprovalView,
} from './deliverables.service.js';

export const DELIVERABLES_SERVICE = Symbol.for('tmanage.DeliverablesService');

/**
 * 0211 (audit gap 1) — the studio's deliverables: create, version, and send for client approval.
 *
 * Every `@RequireCapability` here is internal-only (`work.read`, `deliverable.create`,
 * `deliverable.publish`), so a client principal never passes the coarse ceiling; the service's
 * `authorize()` with the deliverable's project loaded is the real gate. The client side is the
 * existing `approvals/projections/:deliverableVersionId` read and decision routes.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalid(field, 'must be a non-empty string');
  if (value.length > max) throw invalid(field, `must be at most ${max} characters`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid(field, 'must be a string or null');
  if (value.length > max) throw invalid(field, `must be at most ${max} characters`);
  return value.trim() === '' ? null : value;
}

@Controller('v1/organizations/:orgSlug/deliverables')
export class DeliverablesController {
  constructor(@Inject(DELIVERABLES_SERVICE) private readonly deliverables: DeliverablesService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('projectId') projectId: unknown,
  ): Promise<{ readonly deliverables: readonly DeliverableView[] }> {
    const id = requiredText(projectId, 'projectId', 36);
    return { deliverables: await this.deliverables.list(context, principal, id) };
  }

  @Post()
  @HttpCode(201)
  @RequireCapability('deliverable.create')
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: Record<string, unknown>,
  ): Promise<DeliverableView> {
    return this.deliverables.create(context, principal, {
      projectId: requiredText(body['projectId'], 'projectId', 36),
      title: requiredText(body['title'], 'title', 300),
      description: optionalText(body['description'], 'description', 5_000),
    });
  }

  @Get(':deliverableId')
  @RequireCapability('work.read')
  async detail(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
  ): Promise<DeliverableDetailView> {
    return this.deliverables.detail(context, principal, deliverableId);
  }

  @Post(':deliverableId/versions')
  @HttpCode(201)
  @RequireCapability('deliverable.create')
  async addVersion(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<DeliverableVersionView> {
    return this.deliverables.addVersion(context, principal, deliverableId, {
      fileAssetId: optionalText(body['fileAssetId'], 'fileAssetId', 36),
      note: optionalText(body['note'], 'note', 5_000),
    });
  }

  @Get(':deliverableId/approvers')
  @RequireCapability('deliverable.publish')
  async approvers(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
  ): Promise<{ readonly approvers: readonly ApproverView[] }> {
    return { approvers: await this.deliverables.approvers(context, principal, deliverableId) };
  }

  @Post(':deliverableId/versions/:versionId/send')
  @HttpCode(201)
  @RequireCapability('deliverable.publish')
  async send(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<SendForApprovalView> {
    const approverIds = body['approverIds'];
    if (
      !Array.isArray(approverIds) ||
      approverIds.length > 50 ||
      approverIds.some((id) => typeof id !== 'string' || id === '')
    ) {
      throw invalid('approverIds', 'must be an array of up to 50 user ids');
    }
    const dueDate = optionalText(body['dueDate'], 'dueDate', 10);
    if (dueDate !== null && !ISO_DATE.test(dueDate)) throw invalid('dueDate', 'must be YYYY-MM-DD');
    if (body['notify'] !== undefined && typeof body['notify'] !== 'boolean') {
      throw invalid('notify', 'must be a boolean');
    }
    return this.deliverables.send(context, principal, deliverableId, versionId, {
      approverIds: approverIds as string[],
      dueDate,
      checkNote: optionalText(body['checkNote'], 'checkNote', 2_000),
      notify: body['notify'] !== false,
    });
  }
}
