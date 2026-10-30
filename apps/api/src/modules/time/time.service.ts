import type { Principal } from '@tmanage/domain';
import type { TimeTimerRow, WorkItemTimeLogRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ThrottlePolicy, ThrottleSubject } from '../rate-limits/durable-rate-limiter.js';
import type { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { mayTrackOnItem, mayTrackOnProject, requireInternal } from './time-capabilities.js';
import { roundedSpanMinutes } from './time-rounding.js';
import { optionalBoolean, optionalId, optionalNote, utcDay } from './time-rules.js';
import type { TimeRepository } from './time.repository.js';

/**
 * 52-01 — the running timer, member side: start, stop, read, heartbeat, and presence.
 *
 * - **Whose timer.** Always the caller's: the membership comes from the `TenantContext`, never
 *   from a body or a query. There is no route that touches another member's timer; `force` stops
 *   only the caller's own running timer (and files its entry first).
 * - **What it is for.** A work item (resolved tenant-scoped, then `work.read` on it: a stranger's
 *   or another tenant's item is the same 404) or a project (`work.read` on it, and it must exist),
 *   or neither (the entry lands unsorted). Client principals are refused before anything is read.
 * - **When.** `started_at` and `ended_at` are this server's clock. Stop writes exactly one entry
 *   (`source = 'timer'`), rounded up to `org_finance_profiles.rounding_minutes`, and deletes the
 *   timer in the same transaction; the delete's row count makes a racing second stop a 409 rather
 *   than a second entry.
 * - **Presence** (`GET …/time/active`) answers only when the organization turned
 *   `time_presence_visible` on (default off; otherwise 404), and shows a project or item title
 *   only through the viewer's own `work.read` relation to it.
 *
 * Audit: `time_timer.started` and `time_log.created`, ids only (the worker writes
 * `time_timer.auto_stopped`).
 */

/** 56-05 limiter budget for the heartbeat: 2 per minute per member. */
export const HEARTBEAT_POLICY: ThrottlePolicy = {
  name: 'time_heartbeat',
  perMinute: 2,
  key: 'link',
  onStoreError: 'open',
};

export interface TimerView {
  readonly id: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly note: string | null;
  readonly billable: boolean;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly elapsedSeconds: number;
}

export interface TimerStateView {
  readonly timer: TimerView | null;
  readonly serverNow: string;
}

export interface TimeEntryView {
  readonly id: string;
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly minutes: number;
  readonly spentOn: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly billable: boolean;
  readonly source: string;
  readonly needsReview: boolean;
  readonly note: string | null;
}

export interface ActiveTimerView {
  readonly membershipId: string;
  readonly startedAt: string;
  /** Present only when the viewer may read the project. */
  readonly projectId: string | null;
  /** Present only when the viewer may read the work item. */
  readonly workItemId: string | null;
  readonly workItemTitle: string | null;
}

export interface TimeServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<
    TimeRepository,
    | 'findTimer'
    | 'insertTimer'
    | 'deleteTimer'
    | 'touchHeartbeat'
    | 'listRunning'
    | 'projectExists'
    | 'workItemExists'
    | 'roundingMinutes'
    | 'timePolicy'
  >;
  readonly timeLogs: Pick<WorkTimeLogsRepository, 'create'>;
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  readonly audit: Pick<AuditService, 'record'>;
  /** The 56-05 limiter; absent in a composition without one (the heartbeat is then unthrottled). */
  readonly limiter?: {
    check(
      policy: ThrottlePolicy,
      subject: ThrottleSubject,
    ): Promise<{ readonly admitted: boolean }>;
  } | null;
  readonly now?: () => Date;
}

interface Target {
  readonly workItemId: string | null;
  readonly projectId: string | null;
}

const ER_DUP_ENTRY = 1062;

function isDuplicateKey(error: unknown): boolean {
  const marks = (c: unknown): boolean =>
    typeof c === 'object' &&
    c !== null &&
    ((c as { errno?: number }).errno === ER_DUP_ENTRY ||
      (c as { code?: string }).code === 'ER_DUP_ENTRY');
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

// `ApiErrorCode` is a closed list (common/http/errors.ts); the reason rides in `details`.
const timerRunning = (): ApiError =>
  new ApiError(409, 'conflict', 'A timer is already running. Stop it first.', [
    { field: 'timer', message: 'timer_running' },
  ]);
const timerNotRunning = (): ApiError =>
  new ApiError(409, 'conflict', 'No timer is running.', [
    { field: 'timer', message: 'timer_not_running' },
  ]);
const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

export class TimeService {
  private readonly now: () => Date;

  constructor(private readonly options: TimeServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async get(context: TenantContext, principal: Principal): Promise<TimerStateView> {
    requireInternal(principal);
    const at = this.now();
    const row = await this.options.database.read(context, (r) =>
      this.options.repository.findTimer(r, context, context.membershipId),
    );
    return stateOf(row, at);
  }

  async start(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<TimerStateView> {
    requireInternal(principal);
    const input = record(body);
    const workItemId = optionalId(input['workItemId'], 'workItemId');
    const projectId = optionalId(input['projectId'], 'projectId');
    const note = optionalNote(input['note']);
    const billable = optionalBoolean(input['billable'], 'billable', true);
    const force = optionalBoolean(input['force'], 'force', false);
    const at = this.now();
    const repo = this.options.repository;

    return this.options.database.transaction(context, async (tx) => {
      const target = await this.resolveTarget(tx, context, principal, workItemId, projectId);
      const existing = await repo.findTimer(tx, context, context.membershipId, true);
      if (existing !== null) {
        if (!force) throw timerRunning();
        await this.finish(tx, context, existing, at, existing.note);
      }
      let row: TimeTimerRow;
      try {
        row = await repo.insertTimer(tx, context, {
          membershipId: context.membershipId,
          userId: context.userId,
          workItemId: target.workItemId,
          projectId: target.projectId,
          note,
          billable,
          startedAt: at,
        });
      } catch (error) {
        if (isDuplicateKey(error)) throw timerRunning();
        throw error;
      }
      await this.options.audit.record(tx, context, {
        action: 'time_timer.started',
        result: 'allowed',
        objectId: row.id,
        actorUserId: context.userId,
        metadata: {},
      });
      return stateOf(row, at);
    });
  }

  async stop(context: TenantContext, principal: Principal, body: unknown): Promise<TimeEntryView> {
    requireInternal(principal);
    const input = record(body);
    const note = input['note'] === undefined ? undefined : optionalNote(input['note']);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const timer = await this.options.repository.findTimer(
        tx,
        context,
        context.membershipId,
        true,
      );
      if (timer === null) throw timerNotRunning();
      const entry = await this.finish(tx, context, timer, at, note ?? timer.note);
      return entryView(entry);
    });
  }

  async heartbeat(context: TenantContext, principal: Principal): Promise<TimerStateView> {
    requireInternal(principal);
    const limiter = this.options.limiter;
    if (limiter) {
      const decision = await limiter.check(HEARTBEAT_POLICY, {
        link: `${context.organizationId}:${context.membershipId}`,
      });
      if (!decision.admitted) {
        throw new ApiError(429, 'rate_limited', 'Too many tries. Please wait a minute.');
      }
    }
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const timer = await this.options.repository.findTimer(
        tx,
        context,
        context.membershipId,
        true,
      );
      if (timer === null) throw timerNotRunning();
      await this.options.repository.touchHeartbeat(tx, context, timer.id, at);
      return stateOf({ ...timer, lastHeartbeatAt: at }, at);
    });
  }

  /** Who is tracking right now. 404 unless the organization turned presence on. */
  async active(
    context: TenantContext,
    principal: Principal,
    projectIdRaw: string | undefined,
  ): Promise<{ readonly timers: readonly ActiveTimerView[] }> {
    requireInternal(principal);
    const projectId = optionalId(projectIdRaw, 'projectId');
    const repo = this.options.repository;
    return this.options.database.read(context, async (r) => {
      const policy = await repo.timePolicy(r, context);
      if (!policy.presenceVisible) throw notFound();
      if (projectId !== null && !mayTrackOnProject(principal, context, projectId)) throw notFound();
      const rows = await repo.listRunning(r, context, projectId);
      const timers: ActiveTimerView[] = [];
      for (const row of rows) {
        const projectVisible =
          row.projectId !== null && mayTrackOnProject(principal, context, row.projectId);
        let workItemId: string | null = null;
        let workItemTitle: string | null = null;
        if (row.workItemId !== null && projectVisible) {
          const item = await this.options.workItems.findById(r, context, row.workItemId);
          if (item && mayTrackOnItem(principal, item)) {
            workItemId = item.id;
            workItemTitle = item.title;
          }
        }
        timers.push({
          membershipId: row.membershipId,
          startedAt: row.startedAt.toISOString(),
          projectId: projectVisible ? row.projectId : null,
          workItemId,
          workItemTitle,
        });
      }
      return { timers };
    });
  }

  private async resolveTarget(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string | null,
    projectId: string | null,
  ): Promise<Target> {
    if (workItemId !== null) {
      const item = await this.options.workItems.findById(tx, context, workItemId);
      if (!item || !mayTrackOnItem(principal, item)) throw notFound();
      if (projectId !== null && projectId !== item.projectId) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'projectId', message: 'must be the work item’s project' },
        ]);
      }
      return { workItemId: item.id, projectId: item.projectId };
    }
    if (projectId !== null) {
      if (
        !mayTrackOnProject(principal, context, projectId) ||
        !(await this.options.repository.projectExists(tx, context, projectId))
      ) {
        throw notFound();
      }
      return { workItemId: null, projectId };
    }
    return { workItemId: null, projectId: null };
  }

  /** Stop one timer: delete it (losing a race is a 409) and file exactly one entry. */
  private async finish(
    tx: TenantQueryRunner,
    context: TenantContext,
    timer: TimeTimerRow,
    endedAt: Date,
    note: string | null,
  ): Promise<WorkItemTimeLogRow> {
    const repo = this.options.repository;
    if ((await repo.deleteTimer(tx, context, timer.id)) === 0) throw timerNotRunning();
    const rounding = await repo.roundingMinutes(tx, context);
    const workItemId =
      timer.workItemId !== null && (await repo.workItemExists(tx, context, timer.workItemId))
        ? timer.workItemId
        : null;
    const entry = await this.options.timeLogs.create(tx, context, {
      workItemId,
      projectId: timer.projectId,
      loggedBy: timer.membershipId,
      minutes: roundedSpanMinutes(timer.startedAt, endedAt, rounding),
      spentOn: utcDay(timer.startedAt),
      note,
      startedAt: timer.startedAt,
      endedAt,
      billable: timer.billable,
      source: 'timer',
    });
    await this.options.audit.record(tx, context, {
      action: 'time_log.created',
      result: 'allowed',
      objectId: entry.id,
      actorUserId: context.userId,
      metadata: {},
    });
    return entry;
  }
}

function stateOf(row: TimeTimerRow | null, at: Date): TimerStateView {
  return { timer: row === null ? null : timerView(row, at), serverNow: at.toISOString() };
}

function timerView(row: TimeTimerRow, at: Date): TimerView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    projectId: row.projectId,
    note: row.note,
    billable: row.billable,
    startedAt: row.startedAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    elapsedSeconds: Math.max(0, Math.floor((at.getTime() - row.startedAt.getTime()) / 1000)),
  };
}

function entryView(row: WorkItemTimeLogRow): TimeEntryView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    projectId: row.projectId,
    minutes: row.minutes,
    spentOn: row.spentOn,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    billable: row.billable,
    source: row.source,
    needsReview: row.needsReview,
    note: row.note ?? null,
  };
}
