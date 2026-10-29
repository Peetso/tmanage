import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHT_REPORT_SCHEDULES_SERVICE } from '../../common/http/tokens.js';
import { INSIGHT_REPORT_CADENCES, INSIGHT_REPORT_KINDS } from '../../common/database/schema.js';
import type {
  InsightReportCadence,
  InsightReportKind,
  InsightReportScheduleRow,
} from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightReportSchedulesService } from './report-schedules.service.js';

/**
 * INS report schedules (x228) — a member defines, lists and removes their own recurring insights
 * reports (module 15 Insights & reporting): "run the delivery-flow report every Monday at 08:00".
 *
 * ## Own schedules only, and the capability reused rather than invented
 *
 * All three routes are behind **`work.read`** — the internal-read capability the sibling insights
 * reads and saved views reuse, so this slice stays off `capabilities.ts` and the role grid. A caller
 * without `work.read` is refused by the global `CapabilityGuard` with a 403 before any handler runs.
 * None of the routes reads an `organizationId` or an owner from anywhere: the tenant and the acting
 * user are the `TenantContextGuard`'s, and a schedule is always the acting user's own. A schedule is
 * private to its creator, so a delete that names another user's schedule (or none) is a 404 — its
 * existence is not the caller's to learn.
 *
 * ## Definition only — no dispatcher, no egress
 *
 * This slice ships the definition and a computed `nextRunAt`, not a runner: there is no scheduler, no
 * email and no outbound call. `nextRunAt` is computed by the service from a bound `now` (the request's
 * instant, not the DB clock) so a future dispatcher can find due rows.
 *
 * ## Validation is here (400), not in the store
 *
 * `reportKey` is validated against `INSIGHT_REPORT_KINDS`, `cadence` against `INSIGHT_REPORT_CADENCES`,
 * `hour` as an integer 0–23, and — for a weekly schedule — `dayOfWeek` as an integer 0–6 (0=Sunday). A
 * daily schedule carries no `dayOfWeek` (stored `null`). Any violation is a 400 and nothing is written.
 */

/** A scheduled insights report as the screen reads it — paired Exact with the web `ReportScheduleView`. */
export interface ReportScheduleView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly reportKey: InsightReportKind;
  readonly cadence: InsightReportCadence;
  readonly hour: number;
  readonly dayOfWeek: number | null;
  readonly nextRunAt: string;
  readonly createdAt: string;
}

/**
 * The list/mutation response wrapper — the caller's own schedules. Deliberately not an exported
 * `*View` interface (the contracts gate would demand a standalone pair): the web client unwraps it to
 * the array, so the one paired projection is `ReportScheduleView`.
 */
type ReportSchedulesResponse = { readonly schedules: readonly ReportScheduleView[] };

function isReportKind(value: unknown): value is InsightReportKind {
  return typeof value === 'string' && (INSIGHT_REPORT_KINDS as readonly string[]).includes(value);
}

function isCadence(value: unknown): value is InsightReportCadence {
  return (
    typeof value === 'string' && (INSIGHT_REPORT_CADENCES as readonly string[]).includes(value)
  );
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Parse and validate a create body into the stored input, or throw a 400 with per-field details. */
function parseCreate(body: unknown): {
  reportKey: InsightReportKind;
  cadence: InsightReportCadence;
  hour: number;
  dayOfWeek: number | null;
} {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const reportKey = value['reportKey'];
  if (!isReportKind(reportKey)) {
    details.push({
      field: 'reportKey',
      message: `must be one of ${INSIGHT_REPORT_KINDS.join(', ')}`,
    });
  }

  const cadence = value['cadence'];
  if (!isCadence(cadence)) {
    details.push({
      field: 'cadence',
      message: `must be one of ${INSIGHT_REPORT_CADENCES.join(', ')}`,
    });
  }

  const rawHour = value['hour'];
  if (!isInteger(rawHour, 0, 23)) {
    details.push({ field: 'hour', message: 'must be an integer from 0 to 23' });
  }

  // dayOfWeek is required 0–6 for a weekly schedule and must be absent/null for a daily one.
  const rawDay = value['dayOfWeek'];
  let dayOfWeek: number | null = null;
  if (cadence === 'weekly') {
    if (!isInteger(rawDay, 0, 6)) {
      details.push({
        field: 'dayOfWeek',
        message: 'must be an integer from 0 to 6 for a weekly schedule',
      });
    } else {
      dayOfWeek = rawDay;
    }
  } else if (rawDay !== undefined && rawDay !== null) {
    details.push({ field: 'dayOfWeek', message: 'must be omitted for a daily schedule' });
  }

  if (
    details.length > 0 ||
    !isReportKind(reportKey) ||
    !isCadence(cadence) ||
    !isInteger(rawHour, 0, 23)
  ) {
    throw new ApiError(400, 'validation_failed', 'The report schedule is invalid', details);
  }

  return { reportKey, cadence, hour: rawHour, dayOfWeek };
}

function viewOf(row: InsightReportScheduleRow): ReportScheduleView {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    reportKey: row.reportKey,
    cadence: row.cadence,
    hour: row.hour,
    dayOfWeek: row.dayOfWeek,
    nextRunAt: row.nextRunAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

@Controller('v1/organizations/:orgSlug/insights/report-schedules')
export class InsightReportSchedulesController {
  constructor(
    @Inject(INSIGHT_REPORT_SCHEDULES_SERVICE)
    private readonly schedules: InsightReportSchedulesService,
  ) {}

  /** List the acting user's report schedules (200). */
  @Get()
  @RequireCapability('report.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<ReportSchedulesResponse> {
    const rows = await this.schedules.listOwn(context);
    return { schedules: rows.map(viewOf) };
  }

  /** Create a report schedule owned by the acting user (201). An invalid body → 400. */
  @Post()
  @RequireCapability('report.view')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: unknown,
  ): Promise<ReportScheduleView> {
    const input = parseCreate(body);
    const row = await this.schedules.create(context, input, new Date());
    return viewOf(row);
  }

  /**
   * Delete a schedule by id (200). Own-scoped: an id that names another user's schedule (or no
   * schedule) removes nothing and answers 404 — a private schedule's existence is not the caller's to
   * learn.
   */
  @Delete(':scheduleId')
  @RequireCapability('report.view')
  @HttpCode(200)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('scheduleId') scheduleId: string,
  ): Promise<ReportSchedulesResponse> {
    const removed = await this.schedules.deleteOwn(context, scheduleId);
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const rows = await this.schedules.listOwn(context);
    return { schedules: rows.map(viewOf) };
  }
}
