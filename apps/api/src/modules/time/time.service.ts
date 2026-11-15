import {
  authorize,
  isTimeRoundingChoice,
  localDateOf,
  roundedSpanMinutes,
  roundingIncrement,
} from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TimeTimerRow, WorkItemTimeLogRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { defaultProfile } from '../finance/finance-rules.js';
import type { FinanceRepository } from '../finance/finance.repository.js';
import type { ThrottlePolicy, ThrottleSubject } from '../rate-limits/durable-rate-limiter.js';
import { companyTimeZone } from '../tenancy/auto-time-tracking-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { mayTrackOnItem, mayTrackOnProject, requireInternal } from './time-capabilities.js';
import { optionalBoolean, optionalId, optionalMinutes, optionalNote } from './time-rules.js';
import type { TimeRepository } from './time.repository.js';
import { resolveTimeTarget } from './time-target.js';

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
 *   (`source = 'timer'`), rounded up to the owner's step (`org_finance_profiles.rounding_minutes`,
 *   `@tmanage/domain` rounding) and filed on the company-calendar day it started
 *   (`default_timezone`, like automatic time), and deletes the timer in the same transaction; the
 *   delete's row count makes a racing second stop a 409 rather than a second entry.
 * - **Rounding.** Every timer read carries the step, so the Stop dialog announces what is saved.
 *   Only the company owner changes it (`PATCH …/time/rounding`, audited with the actor).
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
  /** The step a stopped timer is rounded up to, in minutes (`0`/`1` = exact minutes). */
  readonly roundingMinutes: number;
}

export interface TimeRoundingView {
  readonly roundingMinutes: number;
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
  /** The company time zone (`default_timezone`) the entries are filed by. */
  readonly settings: Pick<OrgSettingsRepository, 'findByKey'>;
  /** Where the rounding step is stored (`org_finance_profiles`), for the owner's change. */
  readonly finance: Pick<
    FinanceRepository,
    'organization' | 'profile' | 'insertProfile' | 'updateRoundingMinutes'
  >;
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
    return this.options.database.read(context, async (r) =>
      stateOf(
        await this.options.repository.findTimer(r, context, context.membershipId),
        at,
        await this.options.repository.roundingMinutes(r, context),
      ),
    );
  }

  /**
   * The company owner chooses the manual timer's rounding step: one of `TIME_ROUNDING_CHOICES`
   * (1 = no rounding). Stored on the finance profile row (created with its defaults when the
   * company has none yet) and audited with the actor and the previous step. Automatic time is
   * never rounded.
   */
  async setRounding(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<TimeRoundingView> {
    requireInternal(principal);
    const verdict = authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `time_rounding:${verdict.code}`,
      );
    }
    if (principal.role !== 'owner') {
      throw new ApiError(
        403,
        'forbidden',
        'Only the company owner can change this setting.',
        undefined,
        'time_rounding.write:not_owner',
      );
    }
    const value = record(body)['roundingMinutes'];
    if (!isTimeRoundingChoice(value)) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'roundingMinutes', message: 'must be 1 (no rounding), 5, 6, 10, 15 or 30' },
      ]);
    }
    const finance = this.options.finance;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const organization = await finance.organization(tx, context.organizationId);
      if (organization === null) throw notFound();
      const row = await finance.profile(tx, context.organizationId, true);
      const previous = roundingIncrement(row?.roundingMinutes);
      if (row === null) {
        await finance.insertProfile(
          tx,
          context.organizationId,
          { ...defaultProfile(organization), roundingMinutes: value },
          at,
        );
      } else {
        await finance.updateRoundingMinutes(tx, context.organizationId, value, at);
      }
      await this.options.audit.record(tx, context, {
        action: 'organization.time_rounding_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { previous, value },
        changes: [{ field: 'time_rounding_minutes', before: previous, after: value }],
      });
      return { roundingMinutes: value };
    });
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
      const target = await resolveTimeTarget(
        {
          workItems: this.options.workItems,
          projectExists: (r, c, id) => repo.projectExists(r, c, id),
        },
        tx,
        context,
        principal,
        workItemId,
        projectId,
      );
      const existing = await repo.findTimer(tx, context, context.membershipId, true);
      const rounding = await repo.roundingMinutes(tx, context);
      if (existing !== null) {
        if (!force) throw timerRunning();
        await this.finish(tx, context, existing, at, existing.note, rounding);
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
      return stateOf(row, at, rounding);
    });
  }

  async stop(context: TenantContext, principal: Principal, body: unknown): Promise<TimeEntryView> {
    requireInternal(principal);
    const input = record(body);
    const note = input['note'] === undefined ? undefined : optionalNote(input['note']);
    const chosen = optionalMinutes(input['minutes']);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const timer = await this.options.repository.findTimer(
        tx,
        context,
        context.membershipId,
        true,
      );
      if (timer === null) throw timerNotRunning();
      const rounding = await this.options.repository.roundingMinutes(tx, context);
      // UX test T-P1-1: the person may save less than the rounded amount, never more.
      const rounded = roundedSpanMinutes(timer.startedAt, at, rounding);
      if (chosen !== null && chosen > rounded) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'minutes', message: `must be at most ${rounded}` },
        ]);
      }
      const entry = await this.finish(tx, context, timer, at, note ?? timer.note, rounding, chosen);
      return entryView(entry);
    });
  }

  /**
   * UX test T-P1-1: throw away the caller's own running timer. Nothing is filed; the discard is
   * audited with the elapsed seconds, so a manager can see it happened.
   */
  async discard(context: TenantContext, principal: Principal): Promise<TimerStateView> {
    requireInternal(principal);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const timer = await repo.findTimer(tx, context, context.membershipId, true);
      if (timer === null) throw timerNotRunning();
      if ((await repo.deleteTimer(tx, context, timer.id)) === 0) throw timerNotRunning();
      await this.options.audit.record(tx, context, {
        action: 'time_timer.discarded',
        result: 'allowed',
        objectId: timer.id,
        actorUserId: context.userId,
        metadata: {
          elapsed_seconds: Math.max(
            0,
            Math.round((at.getTime() - timer.startedAt.getTime()) / 1000),
          ),
        },
      });
      return stateOf(null, at, await repo.roundingMinutes(tx, context));
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
      return stateOf(
        { ...timer, lastHeartbeatAt: at },
        at,
        await this.options.repository.roundingMinutes(tx, context),
      );
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

  /**
   * Stop one timer: delete it (losing a race is a 409) and file exactly one entry, rounded to the
   * stored step and on the company-calendar day it started.
   */
  private async finish(
    tx: TenantQueryRunner,
    context: TenantContext,
    timer: TimeTimerRow,
    endedAt: Date,
    note: string | null,
    rounding: number | null,
    /** The minutes the person chose in the Stop dialog (already checked), or null = rounded. */
    chosen: number | null = null,
  ): Promise<WorkItemTimeLogRow> {
    const repo = this.options.repository;
    if ((await repo.deleteTimer(tx, context, timer.id)) === 0) throw timerNotRunning();
    const zone = await companyTimeZone(tx, context, this.options.settings);
    const workItemId =
      timer.workItemId !== null && (await repo.workItemExists(tx, context, timer.workItemId))
        ? timer.workItemId
        : null;
    const entry = await this.options.timeLogs.create(tx, context, {
      workItemId,
      projectId: timer.projectId,
      loggedBy: timer.membershipId,
      minutes: chosen ?? roundedSpanMinutes(timer.startedAt, endedAt, rounding),
      spentOn: localDateOf(timer.startedAt, zone),
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

function stateOf(row: TimeTimerRow | null, at: Date, rounding: number | null): TimerStateView {
  return {
    timer: row === null ? null : timerView(row, at),
    serverNow: at.toISOString(),
    roundingMinutes: roundingIncrement(rounding),
  };
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
