import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_SUBTASKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  WorkSubtaskListView,
  WorkSubtaskView,
  WorkSubtasksService,
} from './subtasks.service.js';

/**
 * x307's HTTP surface — a work item's ordered subtasks / breakdown (Work module).
 *
 * A sub-resource of the work item, the way the checklist and typed links are: the parent id is in
 * the path, and the service resolves it tenant-scoped before it authorizes or writes. This
 * controller reads no `organizationId` from anywhere — `TenantContextGuard` built the
 * `TenantContext` from a membership row, and there is no field on any body below for a caller to
 * supply one.
 *
 * The capability gate is coarse (`work.read` to list, `work.update` to write); the row-level
 * decision — may this principal act on *this* item, given its project and audience — is the
 * service's, against the resolved parent.
 */

/** `work_item_subtasks.title` is `VARCHAR(300)`. */
const MAX_TITLE_LENGTH = 300;
/** `position` is `INT UNSIGNED`; a plain ordinal bounded to a sane range. */
const MAX_POSITION = 1_000_000;

interface CreateSubtaskBody {
  readonly title?: unknown;
}

interface UpdateSubtaskBody {
  readonly title?: unknown;
  readonly done?: unknown;
  readonly position?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/subtasks')
export class WorkSubtasksController {
  constructor(@Inject(WORK_SUBTASKS_SERVICE) private readonly subtasks: WorkSubtasksService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkSubtaskListView> {
    return this.subtasks.list(context, principal, workItemId);
  }

  @Post()
  @RequireCapability('work.update')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: CreateSubtaskBody,
  ): Promise<WorkSubtaskView> {
    const title = requiredTitle(body?.title);
    return this.subtasks.add(context, principal, workItemId, { title });
  }

  @Put(':subtaskId')
  @RequireCapability('work.update')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('subtaskId') subtaskId: string,
    @Body() body: UpdateSubtaskBody,
  ): Promise<WorkSubtaskView> {
    const details: { field: string; message: string }[] = [];

    let title: string | undefined;
    if (body?.title !== undefined) {
      if (typeof body.title !== 'string' || body.title.trim() === '') {
        details.push({ field: 'title', message: 'must be a non-empty string' });
      } else if (body.title.trim().length > MAX_TITLE_LENGTH) {
        details.push({
          field: 'title',
          message: `must be ${MAX_TITLE_LENGTH} characters or fewer`,
        });
      } else {
        title = body.title.trim();
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

    let position: number | undefined;
    if (body?.position !== undefined) {
      if (
        typeof body.position !== 'number' ||
        !Number.isInteger(body.position) ||
        body.position < 0 ||
        body.position > MAX_POSITION
      ) {
        details.push({
          field: 'position',
          message: `must be an integer between 0 and ${MAX_POSITION}`,
        });
      } else {
        position = body.position;
      }
    }

    if (
      title === undefined &&
      done === undefined &&
      position === undefined &&
      details.length === 0
    ) {
      details.push({
        field: 'title',
        message: 'nothing to change — send title, done and/or position',
      });
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.subtasks.update(context, principal, workItemId, subtaskId, {
      ...(title === undefined ? {} : { title }),
      ...(done === undefined ? {} : { done }),
      ...(position === undefined ? {} : { position }),
    });
  }

  @Delete(':subtaskId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('subtaskId') subtaskId: string,
  ): Promise<void> {
    if (typeof subtaskId !== 'string' || subtaskId === '') {
      throw new ApiError(400, 'validation_failed', 'subtaskId is required', [
        { field: 'subtaskId', message: 'must be a non-empty string' },
      ]);
    }
    await this.subtasks.remove(context, principal, workItemId, subtaskId);
  }
}

function requiredTitle(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'title', message: 'must be a non-empty string' },
    ]);
  }
  const title = raw.trim();
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` },
    ]);
  }
  return title;
}
