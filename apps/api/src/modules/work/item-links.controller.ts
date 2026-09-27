import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_ITEM_LINKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  WORK_ITEM_LINK_TYPES,
  type WorkItemLinkType,
  type WorkItemLinkView,
  type WorkItemLinksService,
} from './item-links.service.js';

/**
 * x204's HTTP surface — the typed links authored on a work item (Work module 7).
 *
 * A sub-resource of the work item, the way the checklist and comments are: the parent id is in the
 * path (`:workItemId`), and the service resolves both it and any target tenant-scoped before it
 * authorizes or writes. This controller reads no `organizationId` from anywhere — `TenantContextGuard`
 * built the `TenantContext` from a membership row.
 *
 * The capability gate is coarse (`work.read` to list, `work.update` to write); the row-level
 * decision — may this principal act on *this* item — is the service's.
 */

interface CreateLinkBody {
  readonly toWorkItemId?: unknown;
  readonly linkType?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/links')
export class WorkItemLinksController {
  constructor(@Inject(WORK_ITEM_LINKS_SERVICE) private readonly links: WorkItemLinksService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly links: readonly WorkItemLinkView[] }> {
    return { links: await this.links.list(context, principal, workItemId) };
  }

  @Post()
  @RequireCapability('work.update')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: CreateLinkBody,
  ): Promise<WorkItemLinkView> {
    const toWorkItemId = typeof body?.toWorkItemId === 'string' ? body.toWorkItemId.trim() : '';
    if (toWorkItemId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'toWorkItemId', message: 'must be a non-empty string' },
      ]);
    }
    if (!isLinkType(body?.linkType)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        {
          field: 'linkType',
          message: `must be one of ${WORK_ITEM_LINK_TYPES.join(', ')}`,
        },
      ]);
    }
    return this.links.create(context, principal, workItemId, {
      toWorkItemId,
      linkType: body.linkType,
    });
  }

  @Delete(':linkId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    if (typeof linkId !== 'string' || linkId === '') {
      throw new ApiError(400, 'validation_failed', 'linkId is required', [
        { field: 'linkId', message: 'must be a non-empty string' },
      ]);
    }
    await this.links.remove(context, principal, workItemId, linkId);
  }
}

function isLinkType(value: unknown): value is WorkItemLinkType {
  return typeof value === 'string' && (WORK_ITEM_LINK_TYPES as readonly string[]).includes(value);
}
