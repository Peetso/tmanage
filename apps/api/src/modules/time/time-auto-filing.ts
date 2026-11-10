import { dayNumberOf, isoDateOfDayNumber, localDateOf } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TimeAutoTrackingRow, TimeTimerRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { COMPANY_TIME_ZONE_KEY } from '../tenancy/auto-time-tracking-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { mayTrackOnItem, mayTrackOnProject } from './time-capabilities.js';
import {
  automaticMinutes,
  boundAutomaticDay,
  freeSpans,
  nextLocalDayStart,
  settle,
  splitByLocalDay,
} from './time-auto-rules.js';
import type { OpenSession, Span } from './time-auto-rules.js';
import type { TimeAutoRepository } from './time-auto.repository.js';
import { isWithinLockedPeriod, periodContaining } from './time-rules.js';
import type { TimesheetsRepository } from './timesheets.repository.js';
import type { TimeRepository } from './time.repository.js';

/**
 * FIX-2026-11-10 (security review M3, M4, M5, L2) — the one place a finished automatic session
 * becomes time entries, shared by the person's own routes, the owner's "off" switch, Team time and
 * the timesheet. A finished session is:
 *
 * - **cut** where another timed entry of the person (or a running manual timer) already counts;
 * - **split at each local midnight** of the company's time zone (`default_timezone`, DST-safe),
 *   so every piece is filed on the company calendar day it happened on;
 * - **bounded**: automatic time is reported by the person's own device, so a company day holds at
 *   most 16 hours of it, and a day over 12 hours or a session over 6 hours without a break is
 *   flagged `needs_review`;
 * - **never filed into a closed week**: a piece whose day is in a locked period, or in a submitted
 *   or approved timesheet, is filed late on the first open company day as unassigned time,
 *   flagged for review (its `started_at` keeps the day it really happened);
 * - **only on a task the person may still track on**: with the person's principal at hand the
 *   task is checked again; a task (or project) they lost access to receives nothing, and the time
 *   is unassigned. Without it (a reader settling someone else's session) the row's task is the one
 *   the person's last heartbeat confirmed, and the heartbeat clears a task the person lost.
 *
 * Settling: a session no heartbeat can extend any more is filed by whoever reads it next (Team
 * time, a timesheet, the person's own timer), so nothing waits for the person to come back and no
 * screen counts a silent session. There is no worker job: the live site runs without a worker.
 */

export interface AutoTimeFilerOptions {
  readonly database: Pick<TenantDatabase, 'transaction'>;
  readonly repository: Pick<
    TimeAutoRepository,
    | 'timedEntriesOverlapping'
    | 'automaticMinutesBetween'
    | 'staleSessions'
    | 'openSessions'
    | 'update'
  >;
  readonly timers: Pick<TimeRepository, 'findTimer' | 'workItemExists'>;
  readonly sheets: Pick<TimesheetsRepository, 'weekStart' | 'openLocks' | 'findForMember'>;
  readonly settings: Pick<OrgSettingsRepository, 'findByKey'>;
  readonly timeLogs: Pick<WorkTimeLogsRepository, 'create'>;
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

/** The row patch that closes a session. */
export const NO_SESSION = {
  sessionStartedAt: null,
  lastActiveAt: null,
  lastHeartbeatAt: null,
} as const;

/** How many weeks forward a late piece looks for an open day. */
const LATE_SEARCH_WEEKS = 8;

export function openSessionOf(row: TimeAutoTrackingRow | null): OpenSession | null {
  if (
    row === null ||
    row.sessionStartedAt === null ||
    row.lastActiveAt === null ||
    row.lastHeartbeatAt === null
  ) {
    return null;
  }
  return {
    startedAt: row.sessionStartedAt,
    lastActiveAt: row.lastActiveAt,
    lastHeartbeatAt: row.lastHeartbeatAt,
  };
}

export function closedSpan(session: OpenSession): Span {
  return { startedAt: session.startedAt, endedAt: session.lastActiveAt };
}

export interface FileOptions {
  /** The person's running manual timer: nothing is filed after it started. */
  readonly timer: TimeTimerRow | null;
  /** The person themself, to check the task again; null when someone else's read settles it. */
  readonly principal: Principal | null;
  readonly at: Date;
}

export class AutoTimeFiler {
  private readonly now: () => Date;

  constructor(private readonly options: AutoTimeFilerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The company's time zone (an unknown or absent one reads as UTC). */
  async timeZone(r: TenantQueryRunner, context: TenantContext): Promise<string> {
    const row = await this.options.settings.findByKey(r, context, COMPANY_TIME_ZONE_KEY);
    return row?.settingValue?.trim() || 'UTC';
  }

  /**
   * File every silent session of these members (null = the whole company) at its last activity,
   * in its own transaction. Readers call it before they read.
   */
  async settleStale(
    context: TenantContext,
    membershipIds: readonly string[] | null,
  ): Promise<void> {
    const at = this.now();
    await this.options.database.transaction(context, async (tx) => {
      const rows = await this.options.repository.staleSessions(tx, context, membershipIds, at);
      for (const row of rows) {
        const span = settle(openSessionOf(row), at);
        if (span === null) continue;
        const timer = await this.options.timers.findTimer(tx, context, row.membershipId);
        await this.file(tx, context, row, span, { timer, principal: null, at });
        await this.options.repository.update(tx, context, row.id, NO_SESSION, at);
      }
    });
  }

  /** The owner turned tracking off: close every open session at its last activity. */
  async closeAll(tx: TenantQueryRunner, context: TenantContext, at: Date): Promise<number> {
    const rows = await this.options.repository.openSessions(tx, context);
    for (const row of rows) {
      const session = openSessionOf(row);
      if (session !== null) {
        const timer = await this.options.timers.findTimer(tx, context, row.membershipId);
        await this.file(tx, context, row, closedSpan(session), { timer, principal: null, at });
      }
      await this.options.repository.update(tx, context, row.id, NO_SESSION, at);
    }
    return rows.length;
  }

  /** May the person still put time on the row's task? (Re-checked with their principal.) */
  async taskAllowed(
    r: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    row: Pick<TimeAutoTrackingRow, 'workItemId' | 'projectId'>,
  ): Promise<boolean> {
    if (row.workItemId !== null) {
      const item = await this.options.workItems.findById(r, context, row.workItemId);
      if (item === null || !mayTrackOnItem(principal, item)) return false;
    }
    if (row.projectId !== null && !mayTrackOnProject(principal, context, row.projectId)) {
      return false;
    }
    return true;
  }

  /** File a finished session (see the file comment for every rule). Under a minute is not filed. */
  async file(
    tx: TenantQueryRunner,
    context: TenantContext,
    row: TimeAutoTrackingRow,
    span: Span,
    options: FileOptions,
  ): Promise<void> {
    if (span.endedAt.getTime() <= span.startedAt.getTime()) return;
    const o = this.options;
    const busy: { startedAt: Date; endedAt: Date | null }[] = [
      ...(await o.repository.timedEntriesOverlapping(tx, context, row.membershipId, span)),
    ];
    if (options.timer !== null) busy.push({ startedAt: options.timer.startedAt, endedAt: null });

    let task = { workItemId: row.workItemId, projectId: row.projectId };
    if (options.principal !== null) {
      if (!(await this.taskAllowed(tx, context, options.principal, row))) {
        task = { workItemId: null, projectId: null };
      }
    } else if (
      row.workItemId !== null &&
      !(await o.timers.workItemExists(tx, context, row.workItemId))
    ) {
      task = { workItemId: null, projectId: row.projectId };
    }

    const zone = await this.timeZone(tx, context);
    const weekStart = await o.sheets.weekStart(tx, context);
    const today = localDateOf(options.at, zone);
    const sessionMinutes = automaticMinutes(span);
    for (const free of freeSpans(span, busy)) {
      for (const { day, span: piece } of splitByLocalDay(free, zone)) {
        const minutes = automaticMinutes(piece);
        if (minutes < 1) continue;
        const dayStart = nextLocalDayStart(isoDateOfDayNumber(dayNumberOf(day) - 1), zone);
        const already = await o.repository.automaticMinutesBetween(
          tx,
          context,
          row.membershipId,
          dayStart,
          nextLocalDayStart(day, zone),
        );
        const bound = boundAutomaticDay(minutes, already, sessionMinutes);
        if (bound.minutes < 1) continue;
        const endedAt = bound.capped
          ? new Date(piece.startedAt.getTime() + bound.minutes * 60_000)
          : piece.endedAt;
        const closed = await this.closedDay(tx, context, row.membershipId, day, weekStart);
        const spentOn = closed
          ? await this.firstOpenDay(tx, context, row.membershipId, today, weekStart)
          : day;
        const entry = await o.timeLogs.create(tx, context, {
          workItemId: closed ? null : task.workItemId,
          projectId: closed ? null : task.projectId,
          loggedBy: row.membershipId,
          minutes: bound.minutes,
          spentOn,
          note: null,
          startedAt: piece.startedAt,
          endedAt,
          source: 'automatic',
          needsReview: closed || bound.needsReview,
        });
        await o.audit.record(tx, context, {
          action: 'time_log.created',
          result: 'allowed',
          objectId: entry.id,
          actorUserId: row.userId,
          metadata: {
            source: 'automatic',
            ...(closed ? { late_from: day } : {}),
            ...(bound.capped ? { capped: 'day_cap' } : {}),
          },
        });
      }
    }
  }

  /** Is this company day inside a locked period, or a submitted or approved timesheet? */
  private async closedDay(
    tx: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    day: string,
    weekStart: number,
  ): Promise<boolean> {
    const bounds = periodContaining(day, weekStart);
    const locks = await this.options.sheets.openLocks(tx, context, bounds);
    if (isWithinLockedPeriod(day, locks)) return true;
    const sheet = await this.options.sheets.findForMember(
      tx,
      context,
      membershipId,
      bounds.periodStart,
    );
    return sheet !== null && (sheet.state === 'submitted' || sheet.state === 'approved');
  }

  /** The first company day from `today` on that is not closed (a week at a time). */
  private async firstOpenDay(
    tx: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    today: string,
    weekStart: number,
  ): Promise<string> {
    let day = today;
    for (let i = 0; i < LATE_SEARCH_WEEKS; i += 1) {
      if (!(await this.closedDay(tx, context, membershipId, day, weekStart))) return day;
      day = isoDateOfDayNumber(dayNumberOf(periodContaining(day, weekStart).periodEnd) + 1);
    }
    return day;
  }
}
