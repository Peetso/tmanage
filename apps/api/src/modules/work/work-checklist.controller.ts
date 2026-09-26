import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_CHECKLIST_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkChecklistItemView, WorkChecklistService } from './work-checklist.service.js';

/**
 * x145's HTTP surface — a work item's checklist / sub-items (Work module 7).
 *
 * A sub-resource of the work item, the way `POST :workItemId/transitions` and
 * `:workItemId/dependencies` are: the parent id is in the path, and the service resolves it
 * tenant-scoped before it authorizes or writes. This controller reads no `organizationId` from
 * anywhere — `TenantContextGuard` built the `TenantContext` from a membership row, and there is
 * no field on any body below for a caller to supply one.
 *
 * The capability gate is coarse (`work.read` to list, `work.update` to write); the row-level
 * decision — may this principal act on *this* item, given its project and audience — is the
 * service's, against the resolved parent.
 */

/** `work_item_checklist_items.label` is `VARCHAR(300)`. */
const MAX_LABEL_LENGTH = 300;

interface CreateChecklistItemBody {
  readonly label?: unknown;
}

interface UpdateChecklistItemBody {
  readonly label?: unknown;
  readonly done?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/checklist')
export class WorkChecklistController {
  constructor(@Inject(WORK_CHECKLIST_SERVICE) private readonly checklist: WorkChecklistService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<{ readonly items: readonly WorkChecklistItemView[] }> {
    return { items: await this.checklist.list(context, principal, workItemId) };
  }

  @Post()
  @RequireCapability('work.update')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: CreateChecklistItemBody,
  ): Promise<WorkChecklistItemView> {
    const label = requiredLabel(body?.label);
    return this.checklist.add(context, principal, workItemId, { label });
  }

  @Patch(':itemId')
  @RequireCapability('work.update')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('itemId') itemId: string,
    @Body() body: UpdateChecklistItemBody,
  ): Promise<WorkChecklistItemView> {
    const details: { field: string; message: string }[] = [];

    let label: string | undefined;
    if (body?.label !== undefined) {
      if (typeof body.label !== 'string' || body.label.trim() === '') {
        details.push({ field: 'label', message: 'must be a non-empty string' });
      } else if (body.label.trim().length > MAX_LABEL_LENGTH) {
        details.push({ field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` });
      } else {
        label = body.label.trim();
      }
    }

    let done: boolean | undefined;
    if (body?.done !== undefined) {
      if (typeof body.done !== 'boolean') {
        details.push({ field: 'done', message: 'must be a boolean' });
      } else {
        done = body.done;
      }
    }

    if (label === undefined && done === undefined && details.length === 0) {
      details.push({ field: 'label', message: 'nothing to change — send label and/or done' });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.checklist.update(context, principal, workItemId, itemId, {
      ...(label === undefined ? {} : { label }),
      ...(done === undefined ? {} : { done }),
    });
  }
}

function requiredLabel(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'label', message: 'must be a non-empty string' },
    ]);
  }
  const label = raw.trim();
  if (label.length > MAX_LABEL_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'label', message: `must be ${MAX_LABEL_LENGTH} characters or fewer` },
    ]);
  }
  return label;
}
