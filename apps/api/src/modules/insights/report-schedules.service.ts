import type {
  InsightReportCadence,
  InsightReportScheduleRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightReportSchedulesRepository } from './report-schedules.repository.js';

/**
 * The fields a create carries after validation. The clock fields are already range-checked by the
 * controller; `dayOfWeek` is a 0–6 day for a weekly schedule and `null` for a daily one.
 */
export interface InsightReportScheduleInput {
  readonly reportKey: InsightReportScheduleRow['reportKey'];
  readonly cadence: InsightReportCadence;
  readonly hour: number;
  readonly dayOfWeek: number | null;
}

/**
 * The next instant a schedule is due, computed deterministically from a bound `now`.
 *
 * A pure function so it can be unit-tested without a clock or a database — and so `next_run_at` is
 * never the admin-pool clock (the trap the sibling snapshots call out). Everything is computed in UTC:
 * the run lands at `hour:00:00.000` UTC on the next qualifying day strictly after `now`.
 *
 * - **daily:** the next `hour:00` that is strictly after `now`.
 * - **weekly:** the next `hour:00` on `dayOfWeek` (0=Sunday) that is strictly after `now`.
 */
export function computeNextRunAt(
  now: Date,
  cadence: InsightReportCadence,
  hour: number,
  dayOfWeek: number | null,
): Date {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0),
  );
  if (cadence === 'weekly') {
    // Advance to the target weekday at or after today, then past `now`, one day at a time.
    while (next.getUTCDay() !== dayOfWeek || next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }
  // daily: the next `hour:00` strictly after `now`.
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/**
 * INS report schedules (x228) — the create/list/delete orchestration for a member's own recurring
 * insights-report definitions over the tenant transaction wrapper.
 *
 * Every operation is scoped by `(organization_id, owner_user_id = context.userId)` in the repository:
 * a schedule is private to its creator, so a caller can only ever create, list or remove their own.
 * `owner_user_id` is `context.userId`, resolved once per request by the tenant guard and never a body
 * value. `next_run_at` is computed here from the `now` the controller binds, never a DB clock. The
 * service owns the transaction boundary and the next-run compute; the scoped queries are the
 * repository's. There is no dispatcher and no egress in this slice — the definition only.
 */
export class InsightReportSchedulesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly schedules: InsightReportSchedulesRepository = new InsightReportSchedulesRepository(),
  ) {}

  /** Create a schedule owned by the acting user, computing `next_run_at` from `now`. */
  async create(
    context: TenantContext,
    input: InsightReportScheduleInput,
    now: Date,
  ): Promise<InsightReportScheduleRow> {
    const nextRunAt = computeNextRunAt(now, input.cadence, input.hour, input.dayOfWeek);
    return this.database.transaction(context, async (tx) => {
      const id = await this.schedules.create(tx, context, {
        reportKey: input.reportKey,
        cadence: input.cadence,
        hour: input.hour,
        dayOfWeek: input.dayOfWeek,
        nextRunAt,
      });
      const row = await this.schedules.findOwn(tx, context, id);
      // The row was just inserted in this same transaction, so its absence is impossible; the check
      // keeps the return type honest rather than asserting non-null.
      if (!row) {
        throw new Error('insight_report_schedules: inserted row not found in its own transaction');
      }
      return row;
    });
  }

  /** The acting user's schedules in this studio. */
  async listOwn(context: TenantContext): Promise<InsightReportScheduleRow[]> {
    return this.database.read(context, (runner) => this.schedules.listOwn(runner, context));
  }

  /** Delete a schedule by id, scoped to the acting user. `false` when nothing was removed (→ 404). */
  async deleteOwn(context: TenantContext, id: string): Promise<boolean> {
    return this.database.transaction(context, (tx) => this.schedules.deleteOwn(tx, context, id));
  }
}
