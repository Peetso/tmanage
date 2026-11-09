import { authorize } from '@tmanage/domain';
import type { AutoTrackingPolicy, Principal } from '@tmanage/domain';
import type { TimeAutoTrackingRow, TimeTimerRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ThrottlePolicy, ThrottleSubject } from '../rate-limits/durable-rate-limiter.js';
import {
  AUTO_TIME_TRACKING_KEY,
  storedAutoTrackingPolicy,
} from '../tenancy/auto-time-tracking-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { WorkTimeLogsRepository } from '../work/time-logs.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { mayTrackOnItem, requireInternal } from './time-capabilities.js';
import {
  applyHeartbeat,
  automaticMinutes,
  effectiveEnabled,
  freeSpans,
  isLive,
  parseIdleSeconds,
  parseIdleThresholdMinutes,
  parsePolicy,
} from './time-auto-rules.js';
import type { OpenSession, Span } from './time-auto-rules.js';
import type { TimeAutoRepository } from './time-auto.repository.js';
import { optionalBoolean, optionalId, utcDay } from './time-rules.js';
import { resolveTimeTarget } from './time-target.js';
import type { TimeRepository } from './time.repository.js';

/**
 * FIX-2026-11-10 — automatic time tracking, member side: the caller's own settings, current task
 * and heartbeats, and the owner's company policy.
 *
 * - **Whose.** Always the caller's: the membership comes from the `TenantContext`, never from a
 *   body. No route here touches another person's row (the team view reads them, `time-team.*`).
 * - **What is trusted.** Nothing the client says about time. A heartbeat carries `idleSeconds`
 *   only; the server clock and `time-auto-rules.ts` decide every start and end, so a session can
 *   never be in the future, overlap another of the same person, or outlast its heartbeats.
 * - **Where the time goes.** To the current task (a work item the caller may track on, or a
 *   project), or, with none, to unassigned work time the person files later from the timesheet.
 * - **With a manual timer running** the manual timer counts and automatic tracking pauses.
 *
 * Audit: `time_log.created` for each filed session (ids only) and
 * `organization.auto_time_tracking_policy_changed` (previous and new value).
 */

/** 56-05 limiter budget for automatic heartbeats: a minute's worth for two devices and changes. */
export const AUTO_HEARTBEAT_POLICY: ThrottlePolicy = {
  name: 'time_auto_heartbeat',
  perMinute: 12,
  key: 'link',
  onStoreError: 'open',
};

export interface CurrentTaskView {
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
}

export interface AutoSessionView {
  readonly startedAt: string;
  readonly lastActiveAt: string;
  /** Another heartbeat can still extend it. */
  readonly live: boolean;
}

export interface AutoTrackingView {
  readonly policy: AutoTrackingPolicy;
  /** Tracking is on for this person (the policy and their own switch). */
  readonly enabled: boolean;
  /** The person's own switch, "Track my time automatically". */
  readonly ownSwitch: boolean;
  readonly idleThresholdMinutes: number;
  readonly currentTask: CurrentTaskView | null;
  readonly session: AutoSessionView | null;
  readonly manualTimerRunning: boolean;
  /** Who else can see this person's time: the owner, admins and people an admin authorized. */
  readonly visibleTo: 'admins_and_authorized';
  readonly serverNow: string;
}

export interface TimeAutoServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<
    TimeAutoRepository,
    'find' | 'ensureOwn' | 'update' | 'timedEntriesOverlapping'
  >;
  readonly timers: Pick<TimeRepository, 'findTimer' | 'projectExists' | 'workItemExists'>;
  readonly settings: Pick<OrgSettingsRepository, 'findByKey' | 'upsert' | 'resolveOrganization'>;
  readonly timeLogs: Pick<WorkTimeLogsRepository, 'create'>;
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly limiter?: {
    check(
      policy: ThrottlePolicy,
      subject: ThrottleSubject,
    ): Promise<{ readonly admitted: boolean }>;
  } | null;
  readonly now?: () => Date;
}

const DEFAULT_THRESHOLD_MINUTES = 5;

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function openSessionOf(row: TimeAutoTrackingRow | null): OpenSession | null {
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

const NO_SESSION = { sessionStartedAt: null, lastActiveAt: null, lastHeartbeatAt: null } as const;

const trackingOff = (): ApiError =>
  new ApiError(409, 'conflict', 'Automatic time tracking is off for you.', [
    { field: 'enabled', message: 'auto_tracking_off' },
  ]);

export class TimeAutoService {
  private readonly now: () => Date;

  constructor(private readonly options: TimeAutoServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async get(context: TenantContext, principal: Principal): Promise<AutoTrackingView> {
    requireInternal(principal);
    const at = this.now();
    return this.options.database.read(context, async (r) => {
      const policy = await this.policyOn(r, context);
      const row = await this.options.repository.find(r, context, context.membershipId);
      const timer = await this.options.timers.findTimer(r, context, context.membershipId);
      return this.view(r, context, principal, policy, row, timer, at);
    });
  }

  async updateSettings(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingView> {
    requireInternal(principal);
    const input = record(body);
    const ownSwitch = optionalBoolean(input['enabled'], 'enabled', false);
    const idleThresholdMinutes =
      input['idleThresholdMinutes'] === undefined
        ? undefined
        : parseIdleThresholdMinutes(input['idleThresholdMinutes']);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const policy = await this.policyOn(tx, context);
      const row = await this.options.repository.ensureOwn(tx, context, at);
      const timer = await this.options.timers.findTimer(tx, context, context.membershipId);
      const session = openSessionOf(row);
      const stillOn = effectiveEnabled(policy, ownSwitch);
      if (!stillOn && session !== null) {
        await this.file(tx, context, row, closedSpan(session), timer);
      }
      await this.options.repository.update(
        tx,
        context,
        row.id,
        {
          enabled: ownSwitch,
          ...(idleThresholdMinutes === undefined ? {} : { idleThresholdMinutes }),
          ...(!stillOn ? NO_SESSION : {}),
        },
        at,
      );
      const next = await this.options.repository.find(tx, context, context.membershipId);
      return this.view(tx, context, principal, policy, next, timer, at);
    });
  }

  /** Set (or clear) "working on now". An open session is split here: the old task keeps its part. */
  async setCurrentTask(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingView> {
    requireInternal(principal);
    const input = record(body);
    const workItemId = optionalId(input['workItemId'], 'workItemId');
    const projectId = optionalId(input['projectId'], 'projectId');
    const at = this.now();
    const timers = this.options.timers;
    return this.options.database.transaction(context, async (tx) => {
      const target = await resolveTimeTarget(
        {
          workItems: this.options.workItems,
          projectExists: (r, c, id) => timers.projectExists(r, c, id),
        },
        tx,
        context,
        principal,
        workItemId,
        projectId,
      );
      const policy = await this.policyOn(tx, context);
      const row = await this.options.repository.ensureOwn(tx, context, at);
      const timer = await timers.findTimer(tx, context, context.membershipId);
      const session = openSessionOf(row);
      let sessionPatch = {};
      if (session !== null) {
        await this.file(tx, context, row, closedSpan(session), timer);
        sessionPatch =
          isLive(session, at) && timer === null
            ? { sessionStartedAt: session.lastActiveAt, lastActiveAt: at, lastHeartbeatAt: at }
            : NO_SESSION;
      }
      await this.options.repository.update(
        tx,
        context,
        row.id,
        { workItemId: target.workItemId, projectId: target.projectId, ...sessionPatch },
        at,
      );
      const next = await this.options.repository.find(tx, context, context.membershipId);
      return this.view(tx, context, principal, policy, next, timer, at);
    });
  }

  async heartbeat(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingView> {
    requireInternal(principal);
    const idleSeconds = parseIdleSeconds(record(body)['idleSeconds']);
    const limiter = this.options.limiter;
    if (limiter) {
      const decision = await limiter.check(AUTO_HEARTBEAT_POLICY, {
        link: `${context.organizationId}:${context.membershipId}`,
      });
      if (!decision.admitted) {
        throw new ApiError(429, 'rate_limited', 'Too many tries. Please wait a minute.');
      }
    }
    const at = this.now();
    const repo = this.options.repository;
    const view = await this.options.database.transaction(context, async (tx) => {
      const policy = await this.policyOn(tx, context);
      const row = await repo.ensureOwn(tx, context, at);
      const timer = await this.options.timers.findTimer(tx, context, context.membershipId);
      const session = openSessionOf(row);
      if (!effectiveEnabled(policy, row.enabled)) {
        // File what was open, commit, then refuse (outside the transaction).
        if (session !== null) {
          await this.file(tx, context, row, closedSpan(session), timer);
          await repo.update(tx, context, row.id, NO_SESSION, at);
        }
        return null;
      }
      if (timer !== null) {
        // The manual timer counts; automatic tracking files what it had and waits.
        if (session !== null) {
          await this.file(tx, context, row, closedSpan(session), timer);
          await repo.update(tx, context, row.id, NO_SESSION, at);
        }
      } else {
        const outcome = applyHeartbeat(session, at, idleSeconds, row.idleThresholdMinutes * 60);
        if (outcome.closed !== null) await this.file(tx, context, row, outcome.closed, null);
        await repo.update(
          tx,
          context,
          row.id,
          outcome.open === null
            ? NO_SESSION
            : {
                sessionStartedAt: outcome.open.startedAt,
                lastActiveAt: outcome.open.lastActiveAt,
                lastHeartbeatAt: outcome.open.lastHeartbeatAt,
              },
          at,
        );
      }
      const next = await repo.find(tx, context, context.membershipId);
      return this.view(tx, context, principal, policy, next, timer, at);
    });
    if (view === null) throw trackingOff();
    return view;
  }

  /** The company owner sets automatic tracking off, optional or required. Audited. */
  async setPolicy(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<{ readonly policy: AutoTrackingPolicy }> {
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
        `auto_time_tracking:${verdict.code}`,
      );
    }
    if (principal.role !== 'owner') {
      throw new ApiError(
        403,
        'forbidden',
        'Only the company owner can change this setting.',
        undefined,
        'auto_time_tracking.write:not_owner',
      );
    }
    const policy = parsePolicy(record(body)['policy']);
    const settings = this.options.settings;
    return this.options.database.transaction(context, async (tx) => {
      const org = await settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const previous = await this.policyOn(tx, context);
      await settings.upsert(tx, context, {
        key: AUTO_TIME_TRACKING_KEY,
        value: policy,
        updatedBy: principal.userId,
      });
      await this.options.audit.record(tx, context, {
        action: 'organization.auto_time_tracking_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: { previous, value: policy },
      });
      return { policy };
    });
  }

  private async policyOn(
    r: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AutoTrackingPolicy> {
    const row = await this.options.settings.findByKey(r, context, AUTO_TIME_TRACKING_KEY);
    return storedAutoTrackingPolicy(row?.settingValue);
  }

  /**
   * File a finished session as `automatic` entries on the stretches no other timed entry of the
   * person covers (and never after a running manual timer started). Under a minute is not filed.
   */
  private async file(
    tx: TenantQueryRunner,
    context: TenantContext,
    row: TimeAutoTrackingRow,
    span: Span,
    timer: TimeTimerRow | null,
  ): Promise<void> {
    if (span.endedAt.getTime() <= span.startedAt.getTime()) return;
    const busy: { startedAt: Date; endedAt: Date | null }[] = [
      ...(await this.options.repository.timedEntriesOverlapping(
        tx,
        context,
        row.membershipId,
        span,
      )),
    ];
    if (timer !== null) busy.push({ startedAt: timer.startedAt, endedAt: null });
    const workItemId =
      row.workItemId !== null &&
      (await this.options.timers.workItemExists(tx, context, row.workItemId))
        ? row.workItemId
        : null;
    for (const piece of freeSpans(span, busy)) {
      const minutes = automaticMinutes(piece);
      if (minutes < 1) continue;
      const entry = await this.options.timeLogs.create(tx, context, {
        workItemId,
        projectId: row.projectId,
        loggedBy: row.membershipId,
        minutes,
        spentOn: utcDay(piece.startedAt),
        note: null,
        startedAt: piece.startedAt,
        endedAt: piece.endedAt,
        source: 'automatic',
      });
      await this.options.audit.record(tx, context, {
        action: 'time_log.created',
        result: 'allowed',
        objectId: entry.id,
        actorUserId: context.userId,
        metadata: {},
      });
    }
  }

  private async view(
    r: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    policy: AutoTrackingPolicy,
    row: TimeAutoTrackingRow | null,
    timer: TimeTimerRow | null,
    at: Date,
  ): Promise<AutoTrackingView> {
    const ownSwitch = row?.enabled ?? false;
    const session = openSessionOf(row);
    let currentTask: CurrentTaskView | null = null;
    if (row !== null && (row.workItemId !== null || row.projectId !== null)) {
      const item =
        row.workItemId === null
          ? null
          : await this.options.workItems.findById(r, context, row.workItemId);
      currentTask = {
        workItemId: row.workItemId,
        projectId: row.projectId,
        title: item !== null && mayTrackOnItem(principal, item) ? item.title : null,
      };
    }
    return {
      policy,
      enabled: effectiveEnabled(policy, ownSwitch),
      ownSwitch,
      idleThresholdMinutes: row?.idleThresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES,
      currentTask,
      session:
        session === null
          ? null
          : {
              startedAt: session.startedAt.toISOString(),
              lastActiveAt: session.lastActiveAt.toISOString(),
              live: isLive(session, at),
            },
      manualTimerRunning: timer !== null,
      visibleTo: 'admins_and_authorized',
      serverNow: at.toISOString(),
    };
  }
}

function closedSpan(session: OpenSession): Span {
  return { startedAt: session.startedAt, endedAt: session.lastActiveAt };
}
