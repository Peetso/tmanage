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
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { MEETING_ACTION_ITEMS_SERVICE } from './meeting-action-items.tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ActionItemStatus, UpdateActionItemInput } from './meeting-action-items.repository.js';
import type {
  MeetingActionItemView,
  MeetingActionItemsService,
} from './meeting-action-items.service.js';

/**
 * CAL / MTG-03 meeting action items (x266). The calendar module's action-item endpoints: capture an
 * action on a meeting, list a meeting's actions, edit one, toggle it open/done, and remove it.
 *
 * Like every tenant-scoped controller here, it never reads `organizationId` from the body, a header,
 * or its own `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built and
 * passes it on. The meeting and the action item are named by the path and resolved tenant-scoped in
 * the service **before** the relation check and any write (the Known-trap order), so a cross-tenant
 * `meetingId`/`actionItemId` is a 404 with no write, never a 500.
 *
 * The write routes require `meeting.write` (the authoring capability meetings already use) and the
 * read route `meeting.read`, mirroring `MeetingAttendeesController`.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE_LENGTH = 500;
const STATUSES: readonly ActionItemStatus[] = ['open', 'done'];

interface CreateActionItemBody {
  readonly title?: unknown;
  readonly ownerMembershipId?: unknown;
  readonly dueOn?: unknown;
}

interface UpdateActionItemBody {
  readonly title?: unknown;
  readonly ownerMembershipId?: unknown;
  readonly dueOn?: unknown;
  readonly status?: unknown;
}

/** Validate a `YYYY-MM-DD` value, returning it or pushing a field error. */
function parseDueOn(
  raw: unknown,
  details: { field: string; message: string }[],
): string | null | undefined {
  if (raw === null) return null;
  if (
    typeof raw !== 'string' ||
    !DATE_ONLY.test(raw) ||
    Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
  ) {
    details.push({ field: 'dueOn', message: 'must be a YYYY-MM-DD date or null' });
    return undefined;
  }
  return raw;
}

@Controller('v1/organizations/:orgSlug/meetings/:meetingId/action-items')
export class MeetingActionItemsController {
  constructor(
    @Inject(MEETING_ACTION_ITEMS_SERVICE) private readonly actionItems: MeetingActionItemsService,
  ) {}

  @Get()
  @RequireCapability('meeting.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly actionItems: readonly MeetingActionItemView[] }> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      actionItems: await this.actionItems.list(context, principal, {
        meetingId,
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Body() body: CreateActionItemBody,
  ): Promise<MeetingActionItemView> {
    const details: { field: string; message: string }[] = [];

    if (!meetingId) details.push({ field: 'meetingId', message: 'must be a non-empty string' });

    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (title === '') {
      details.push({ field: 'title', message: 'must be a non-empty string' });
    } else if (title.length > MAX_TITLE_LENGTH) {
      details.push({ field: 'title', message: `must be ${MAX_TITLE_LENGTH} characters or fewer` });
    }

    let ownerMembershipId: string | null = null;
    if (body?.ownerMembershipId !== undefined && body.ownerMembershipId !== null) {
      if (typeof body.ownerMembershipId !== 'string' || body.ownerMembershipId === '') {
        details.push({ field: 'ownerMembershipId', message: 'must be a non-empty string or null' });
      } else {
        ownerMembershipId = body.ownerMembershipId;
      }
    }

    const dueOn = body?.dueOn === undefined ? null : parseDueOn(body.dueOn, details);

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.actionItems.create(context, principal, {
      meetingId,
      title,
      ownerMembershipId,
      dueOn: dueOn ?? null,
    });
  }

  @Patch(':actionItemId')
  @RequireCapability('meeting.write')
  async update(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('actionItemId') actionItemId: string,
    @Body() body: UpdateActionItemBody,
  ): Promise<MeetingActionItemView> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof actionItemId !== 'string' || actionItemId === '') {
      throw new ApiError(400, 'validation_failed', 'actionItemId is required', [
        { field: 'actionItemId', message: 'must be a non-empty string' },
      ]);
    }

    const details: { field: string; message: string }[] = [];
    const changes: UpdateActionItemInput = {};

    if (body?.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (title === '') {
        details.push({ field: 'title', message: 'must be a non-empty string' });
      } else if (title.length > MAX_TITLE_LENGTH) {
        details.push({
          field: 'title',
          message: `must be ${MAX_TITLE_LENGTH} characters or fewer`,
        });
      } else {
        changes.title = title;
      }
    }

    if (body?.ownerMembershipId !== undefined) {
      if (body.ownerMembershipId === null) {
        changes.ownerMembershipId = null;
      } else if (typeof body.ownerMembershipId === 'string' && body.ownerMembershipId !== '') {
        changes.ownerMembershipId = body.ownerMembershipId;
      } else {
        details.push({ field: 'ownerMembershipId', message: 'must be a non-empty string or null' });
      }
    }

    if (body?.dueOn !== undefined) {
      const dueOn = parseDueOn(body.dueOn, details);
      if (dueOn !== undefined) changes.dueOn = dueOn;
    }

    if (body?.status !== undefined) {
      if (
        typeof body.status === 'string' &&
        (STATUSES as readonly string[]).includes(body.status)
      ) {
        changes.status = body.status as ActionItemStatus;
      } else {
        details.push({ field: 'status', message: "must be 'open' or 'done'" });
      }
    }

    if (details.length > 0) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.actionItems.update(context, principal, { meetingId, actionItemId, changes });
  }

  @Delete(':actionItemId')
  @RequireCapability('meeting.write')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('meetingId') meetingId: string,
    @Param('actionItemId') actionItemId: string,
  ): Promise<void> {
    if (typeof meetingId !== 'string' || meetingId === '') {
      throw new ApiError(400, 'validation_failed', 'meetingId is required', [
        { field: 'meetingId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof actionItemId !== 'string' || actionItemId === '') {
      throw new ApiError(400, 'validation_failed', 'actionItemId is required', [
        { field: 'actionItemId', message: 'must be a non-empty string' },
      ]);
    }

    await this.actionItems.remove(context, principal, { meetingId, actionItemId });
  }
}
