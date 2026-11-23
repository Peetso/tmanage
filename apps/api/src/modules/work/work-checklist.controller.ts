import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_CHECKLIST_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkChecklistItemView, WorkChecklistService } from './work-checklist.service.js';
import type { WorkItemView } from './work-items.service.js';

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

/** A step's due day: a real calendar date, `YYYY-MM-DD`. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A work holds at most this many steps in one reorder (the repository's page bound). */
const MAX_STEPS_IN_ORDER = 500;

interface CreateChecklistItemBody {
  readonly label?: unknown;
  readonly assigneeUserId?: unknown;
  readonly dueOn?: unknown;
}

interface UpdateChecklistItemBody {
  readonly label?: unknown;
  readonly done?: unknown;
  readonly assigneeUserId?: unknown;
  readonly dueOn?: unknown;
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
    const details: { field: string; message: string }[] = [];
    const assigneeUserId = optionalAssignee(body?.assigneeUserId, details);
    const dueOn = optionalDay(body?.dueOn, details);
    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }
    return this.checklist.add(context, principal, workItemId, {
      label,
      ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
      ...(dueOn === undefined ? {} : { dueOn }),
    });
  }

  /** Work area D3: the steps' new order — every step id of the work once. */
  @Put('order')
  @RequireCapability('work.update')
  async reorder(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly itemIds?: unknown },
  ): Promise<{ readonly items: readonly WorkChecklistItemView[] }> {
    const ids = body?.itemIds;
    if (
      !Array.isArray(ids) ||
      ids.length > MAX_STEPS_IN_ORDER ||
      ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 64)
    ) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'itemIds', message: `must be a list of at most ${MAX_STEPS_IN_ORDER} step ids` },
      ]);
    }
    return { items: await this.checklist.reorder(context, principal, workItemId, ids as string[]) };
  }

  /** Work area D3: delete a step. */
  @Delete(':itemId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('itemId') itemId: string,
  ): Promise<void> {
    await this.checklist.remove(context, principal, workItemId, itemId);
  }

  /** Work area D3: turn a step into a work of its own in the same project. */
  @Post(':itemId/convert')
  @RequireCapability('work.create')
  @HttpCode(201)
  async convert(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('itemId') itemId: string,
  ): Promise<WorkItemView> {
    return this.checklist.convert(context, principal, workItemId, itemId);
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
        details.push({
          field: 'label',
          message: `must be ${MAX_LABEL_LENGTH} characters or fewer`,
        });
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

    const assigneeUserId = optionalAssignee(body?.assigneeUserId, details);
    const dueOn = optionalDay(body?.dueOn, details);

    if (
      label === undefined &&
      done === undefined &&
      assigneeUserId === undefined &&
      dueOn === undefined &&
      details.length === 0
    ) {
      details.push({
        field: 'label',
        message: 'nothing to change — send label, done, assigneeUserId and/or dueOn',
      });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.checklist.update(context, principal, workItemId, itemId, {
      ...(label === undefined ? {} : { label }),
      ...(done === undefined ? {} : { done }),
      ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
      ...(dueOn === undefined ? {} : { dueOn }),
    });
  }
}

/** `undefined` = not sent, `null` = nobody, else a user id. */
function optionalAssignee(
  raw: unknown,
  details: { field: string; message: string }[],
): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) {
    details.push({ field: 'assigneeUserId', message: 'must be a user id or null' });
    return undefined;
  }
  return raw;
}

/** `undefined` = not sent, `null` = no day, else a real `YYYY-MM-DD` date. */
function optionalDay(
  raw: unknown,
  details: { field: string; message: string }[],
): string | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const parsed = typeof raw === 'string' && DAY.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    details.push({ field: 'dueOn', message: 'must be a date as YYYY-MM-DD, or null' });
    return undefined;
  }
  return raw;
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
