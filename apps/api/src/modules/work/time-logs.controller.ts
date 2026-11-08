import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { IdempotencyReplayInterceptor } from '../../common/http/idempotency-replay.interceptor.js';
import { WORK_TIME_LOGS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { optionalBoolean, parseManualSpan, utcDay } from '../time/time-rules.js';
import { spanMinutes } from '../time/time-rounding.js';
import type { TimeLogListView, TimeLogView, WorkTimeLogsService } from './time-logs.service.js';

/**
 * x231's HTTP surface — a work item's logged effort / time entries (Work module 7).
 *
 * A sub-resource of the work item, like the checklist and comments: the parent id is in the path,
 * and the service resolves it tenant-scoped before it authorizes or writes. This controller reads no
 * `organizationId` from anywhere — `TenantContextGuard` built the `TenantContext` from a membership
 * row, and there is no field on any body below for a caller to supply one.
 *
 * The capability gate is coarse (`work.read` to list, `work.update` to write); the row-level
 * decisions — may this principal act on *this* item, and is this their own entry to delete — are the
 * service's.
 */

/** One day of effort in minutes, bounded to a single day so a fat-finger cannot log a year. */
const MAX_MINUTES = 24 * 60;

/** `work_item_time_logs.note` is `VARCHAR(500)`. */
const MAX_NOTE_LENGTH = 500;

/** `spent_on` is a `DATE`; the request carries a `YYYY-MM-DD` calendar day, never a clock reading. */
const SPENT_ON_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface CreateTimeLogBody {
  readonly minutes?: unknown;
  readonly spentOn?: unknown;
  readonly note?: unknown;
  /** 52-01. Both or neither; inside the last 31 days. */
  readonly startedAt?: unknown;
  readonly endedAt?: unknown;
  readonly billable?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/time-logs')
export class WorkTimeLogsController {
  constructor(@Inject(WORK_TIME_LOGS_SERVICE) private readonly timeLogs: WorkTimeLogsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<TimeLogListView> {
    return this.timeLogs.list(context, principal, workItemId);
  }

  @Post()
  @RequireCapability('work.update')
  @HttpCode(201)
  // 53-16: an offline replay sends `Idempotency-Key`, so a lost response never writes twice.
  @UseInterceptors(IdempotencyReplayInterceptor)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: CreateTimeLogBody,
  ): Promise<TimeLogView> {
    // 52-01. A start/end pair may stand in for `minutes` and `spentOn` (whole minutes of the span,
    // the UTC day it started); sent together with them, the typed values win.
    const span = parseManualSpan(body?.startedAt, body?.endedAt, new Date());
    const minutes =
      span !== null && body?.minutes === undefined
        ? Math.min(spanMinutes(span.endedAt.getTime() - span.startedAt.getTime()), MAX_MINUTES)
        : requiredMinutes(body?.minutes);
    const spentOn =
      span !== null && body?.spentOn === undefined
        ? utcDay(span.startedAt)
        : requiredSpentOn(body?.spentOn);
    const note = optionalNote(body?.note);
    const billable = optionalBoolean(body?.billable, 'billable', true);
    return this.timeLogs.add(context, principal, workItemId, {
      minutes,
      spentOn,
      note,
      startedAt: span?.startedAt ?? null,
      endedAt: span?.endedAt ?? null,
      billable,
    });
  }

  @Delete(':entryId')
  @RequireCapability('work.update')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Param('entryId') entryId: string,
  ): Promise<void> {
    await this.timeLogs.remove(context, principal, workItemId, entryId);
  }
}

function requiredMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > MAX_MINUTES) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'minutes', message: `must be a whole number of minutes, 1 to ${MAX_MINUTES}` },
    ]);
  }
  return raw;
}

function requiredSpentOn(raw: unknown): string {
  if (typeof raw !== 'string' || !SPENT_ON_PATTERN.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'spentOn', message: 'must be a calendar day in YYYY-MM-DD form' },
    ]);
  }
  return raw;
}

function optionalNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: 'must be a string' },
    ]);
  }
  const note = raw.trim();
  if (note === '') return null;
  if (note.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'note', message: `must be ${MAX_NOTE_LENGTH} characters or fewer` },
    ]);
  }
  return note;
}
