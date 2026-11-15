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
import {
  AUTO_TIME_TRACKING_KEY,
  AUTO_TIME_TRACKING_MAX_IDLE_KEY,
  storedAutoTrackingPolicy,
  storedMaxIdleMinutes,
} from '../tenancy/auto-time-tracking-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import { mayTrackOnItem, requireInternal } from './time-capabilities.js';
import { NO_SESSION, closedSpan, openSessionOf } from './time-auto-filing.js';
import type { AutoTimeFiler } from './time-auto-filing.js';
import {
  AUTO_HEARTBEAT_POLICY,
  AUTO_TASK_POLICY,
  InProcessAutoLimiter,
  chargeAuto,
} from './time-auto-limits.js';
import type { AutoLimiter } from './time-auto-limits.js';
import {
  applyHeartbeat,
  effectiveEnabled,
  isLive,
  parseIdleSeconds,
  parseIdleThresholdMinutes,
  parseDeviceKind,
  parsePolicy,
  splitAt,
} from './time-auto-rules.js';
import type { TimeAutoRepository } from './time-auto.repository.js';
import { optionalBoolean, optionalId } from './time-rules.js';
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
 *   never be in the future, overlap another of the same person, or outlast its heartbeats. The
 *   hours are still reported by the person's device, so `AutoTimeFiler` caps and flags them.
 * - **When it is off** (the owner's policy, or the person's own switch) no route opens or extends a
 *   session: a heartbeat files what was open and is refused, a task change files and closes, and
 *   the owner switching to "off" closes everyone's open session at once.
 * - **Where the time goes.** To the current task (a work item the caller may track on, or a
 *   project), or, with none, to unassigned work time the person files later from the timesheet.
 * - **With a manual timer running** the manual timer counts and automatic tracking pauses.
 * - **Brakes.** Heartbeats and task changes are rate-limited; the limiter fails closed.
 *
 * Audit: `time_log.created` for each filed piece (ids only) and
 * `organization.auto_time_tracking_policy_changed` (previous and new values, the actor).
 */

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

/** The company's automatic tracking policy, as `PATCH …/time/auto/policy` returns it. */
export interface AutoTrackingPolicyView {
  readonly policy: AutoTrackingPolicy;
  readonly maxIdleMinutes: number;
}

export interface AutoTrackingView {
  readonly policy: AutoTrackingPolicy;
  /** Tracking is on for this person (the policy and their own switch). */
  readonly enabled: boolean;
  /** The person's own switch, "Track my time automatically". */
  readonly ownSwitch: boolean;
  /**
   * When someone counts as away: the workspace's one setting (owner only, 1..15 minutes). Stored
   * personal thresholds from before 2026-11-14 are ignored.
   */
  readonly idleThresholdMinutes: number;
  /** The same workspace value, under the name the owner's setting saves it with. */
  readonly maxIdleMinutes: number;
  readonly currentTask: CurrentTaskView | null;
  readonly session: AutoSessionView | null;
  readonly manualTimerRunning: boolean;
  /** Who else can see this person's time: the owner, admins and people an admin authorized. */
  readonly visibleTo: 'admins_and_authorized';
  readonly serverNow: string;
}

export interface TimeAutoServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<TimeAutoRepository, 'find' | 'ensureOwn' | 'update'>;
  readonly timers: Pick<TimeRepository, 'findTimer' | 'projectExists'>;
  readonly settings: Pick<OrgSettingsRepository, 'findByKey' | 'upsert' | 'resolveOrganization'>;
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  readonly audit: Pick<AuditService, 'record'>;
  /** Files finished sessions (shared with Team time and the timesheet). */
  readonly filer: AutoTimeFiler;
  /** The durable limiter; absent = an in-process window (never no brake, review L4). */
  readonly limiter?: AutoLimiter | null;
  readonly now?: () => Date;
}

interface CompanyRules {
  readonly policy: AutoTrackingPolicy;
  readonly maxIdleMinutes: number;
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

const trackingOff = (): ApiError =>
  new ApiError(409, 'conflict', 'Automatic time tracking is off for you.', [
    { field: 'enabled', message: 'auto_tracking_off' },
  ]);

export class TimeAutoService {
  private readonly now: () => Date;
  private readonly limiter: AutoLimiter;

  constructor(private readonly options: TimeAutoServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.limiter = options.limiter ?? new InProcessAutoLimiter();
  }

  async get(context: TenantContext, principal: Principal): Promise<AutoTrackingView> {
    requireInternal(principal);
    // Review M5: a silent session is filed now, not when the person's next heartbeat comes.
    await this.options.filer.settleStale(context, [context.membershipId]);
    const at = this.now();
    return this.options.database.read(context, async (r) => {
      const rules = await this.rulesOn(r, context);
      const row = await this.options.repository.find(r, context, context.membershipId);
      const timer = await this.options.timers.findTimer(r, context, context.membershipId);
      return this.view(r, context, principal, rules, row, timer, at);
    });
  }

  async updateSettings(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingView> {
    requireInternal(principal);
    const input = record(body);
    // The person's own switch is the only personal setting: when someone counts as away is the
    // workspace's (an `idleThresholdMinutes` an older client still sends is ignored).
    const ownSwitch = optionalBoolean(input['enabled'], 'enabled', false);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const rules = await this.rulesOn(tx, context);
      const row = await this.options.repository.ensureOwn(tx, context, at);
      const timer = await this.options.timers.findTimer(tx, context, context.membershipId);
      const session = openSessionOf(row);
      const stillOn = effectiveEnabled(rules.policy, ownSwitch);
      if (!stillOn && session !== null) {
        await this.options.filer.file(tx, context, row, closedSpan(session), {
          timer,
          principal,
          at,
        });
      }
      await this.options.repository.update(
        tx,
        context,
        row.id,
        { enabled: ownSwitch, ...(!stillOn ? NO_SESSION : {}) },
        at,
      );
      const next = await this.options.repository.find(tx, context, context.membershipId);
      return this.view(tx, context, principal, rules, next, timer, at);
    });
  }

  /**
   * Set (or clear) "working on now". A live session is split at this moment (live check B4): the
   * old task keeps the time up to the click, which is itself activity, and the new piece starts
   * at the click. The old heartbeat is kept (review M2: a task change is no heartbeat), so the
   * session ends exactly when it would have without the change; a session no heartbeat can extend
   * any more is filed at its last activity and closed. With tracking off for the person the open
   * session is filed and closed, and none opens. Rate-limited like the heartbeat.
   */
  async setCurrentTask(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingView> {
    requireInternal(principal);
    const input = record(body);
    const workItemId = optionalId(input['workItemId'], 'workItemId');
    const projectId = optionalId(input['projectId'], 'projectId');
    await chargeAuto(this.limiter, AUTO_TASK_POLICY, context.organizationId, context.membershipId);
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
      const rules = await this.rulesOn(tx, context);
      const row = await this.options.repository.ensureOwn(tx, context, at);
      const timer = await timers.findTimer(tx, context, context.membershipId);
      const session = openSessionOf(row);
      let sessionPatch = {};
      if (session !== null) {
        const keepsGoing =
          effectiveEnabled(rules.policy, row.enabled) && isLive(session, at) && timer === null;
        const split = keepsGoing ? splitAt(session, at) : closedSpan(session);
        await this.options.filer.file(tx, context, row, split, { timer, principal, at });
        sessionPatch = keepsGoing
          ? {
              sessionStartedAt: split.endedAt,
              lastActiveAt: split.endedAt,
              lastHeartbeatAt: session.lastHeartbeatAt,
            }
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
      return this.view(tx, context, principal, rules, next, timer, at);
    });
  }

  /**
   * The page reports where the person's tracking runs (TIMER item 17): the desktop app, or a
   * browser and its idle-detection permission. Only that word and this server's clock are stored,
   * on the caller's own row; the owner reads it in Team time. Rate-limited with the task changes.
   */
  async reportDevice(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<{ readonly device: string }> {
    requireInternal(principal);
    const device = parseDeviceKind(record(body)['device']);
    await chargeAuto(this.limiter, AUTO_TASK_POLICY, context.organizationId, context.membershipId);
    const at = this.now();
    await this.options.database.transaction(context, async (tx) => {
      const row = await this.options.repository.ensureOwn(tx, context, at);
      await this.options.repository.update(
        tx,
        context,
        row.id,
        { deviceKind: device, deviceSeenAt: at },
        at,
      );
    });
    return { device };
  }

  async heartbeat(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingView> {
    requireInternal(principal);
    const idleSeconds = parseIdleSeconds(record(body)['idleSeconds']);
    await chargeAuto(
      this.limiter,
      AUTO_HEARTBEAT_POLICY,
      context.organizationId,
      context.membershipId,
    );
    const at = this.now();
    const repo = this.options.repository;
    const filer = this.options.filer;
    const view = await this.options.database.transaction(context, async (tx) => {
      const rules = await this.rulesOn(tx, context);
      let row = await repo.ensureOwn(tx, context, at);
      const timer = await this.options.timers.findTimer(tx, context, context.membershipId);
      const session = openSessionOf(row);
      const fileOptions = { timer, principal, at };
      if (!effectiveEnabled(rules.policy, row.enabled)) {
        // File what was open, commit, then refuse (outside the transaction).
        if (session !== null) {
          await filer.file(tx, context, row, closedSpan(session), fileOptions);
          await repo.update(tx, context, row.id, NO_SESSION, at);
        }
        return null;
      }
      // Review L2: a task the person can no longer reach receives nothing from now on.
      if (
        (row.workItemId !== null || row.projectId !== null) &&
        !(await filer.taskAllowed(tx, context, principal, row))
      ) {
        await repo.update(tx, context, row.id, { workItemId: null, projectId: null }, at);
        row = { ...row, workItemId: null, projectId: null };
      }
      if (timer !== null) {
        // The manual timer counts; automatic tracking files what it had and waits.
        if (session !== null) {
          await filer.file(tx, context, row, closedSpan(session), fileOptions);
          await repo.update(tx, context, row.id, NO_SESSION, at);
        }
      } else {
        const outcome = applyHeartbeat(session, at, idleSeconds, rules.maxIdleMinutes * 60);
        if (outcome.closed !== null) {
          await filer.file(tx, context, row, outcome.closed, fileOptions);
        }
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
      return this.view(tx, context, principal, rules, next, timer, at);
    });
    if (view === null) throw trackingOff();
    return view;
  }

  /**
   * The company owner sets automatic tracking off, optional or required, and when someone counts
   * as away (`maxIdleMinutes`, 1..15, the one threshold for everyone). Audited with the actor. "Off" closes every open
   * session at its last activity at once (review M2).
   */
  async setPolicy(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<AutoTrackingPolicyView> {
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
    const input = record(body);
    const policy = parsePolicy(input['policy']);
    const maxIdle =
      input['maxIdleMinutes'] === undefined
        ? undefined
        : parseIdleThresholdMinutes(input['maxIdleMinutes'], 'maxIdleMinutes');
    const settings = this.options.settings;
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const org = await settings.resolveOrganization(tx, context);
      if (!org) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const previous = await this.rulesOn(tx, context);
      await settings.upsert(tx, context, {
        key: AUTO_TIME_TRACKING_KEY,
        value: policy,
        updatedBy: principal.userId,
      });
      if (maxIdle !== undefined) {
        await settings.upsert(tx, context, {
          key: AUTO_TIME_TRACKING_MAX_IDLE_KEY,
          value: String(maxIdle),
          updatedBy: principal.userId,
        });
      }
      const closed = policy === 'off' ? await this.options.filer.closeAll(tx, context, at) : 0;
      const maxIdleMinutes = maxIdle ?? previous.maxIdleMinutes;
      await this.options.audit.record(tx, context, {
        action: 'organization.auto_time_tracking_policy_changed',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: principal.userId,
        metadata: {
          previous: previous.policy,
          value: policy,
          previous_max_idle_minutes: previous.maxIdleMinutes,
          max_idle_minutes: maxIdleMinutes,
          sessions_closed: closed,
        },
        // What the owner reads in Control > Audit log ("What changed"); the web names each field
        // and policy value from the catalogs (AuditChangeField.* / AuditChangeValue.*).
        changes: [
          { field: 'auto_time_tracking', before: previous.policy, after: policy },
          { field: 'max_idle_minutes', before: previous.maxIdleMinutes, after: maxIdleMinutes },
          ...(policy === 'off' ? [{ field: 'open_auto_sessions', before: closed, after: 0 }] : []),
        ],
      });
      return { policy, maxIdleMinutes };
    });
  }

  private async rulesOn(r: TenantQueryRunner, context: TenantContext): Promise<CompanyRules> {
    const [policy, maxIdle] = await Promise.all([
      this.options.settings.findByKey(r, context, AUTO_TIME_TRACKING_KEY),
      this.options.settings.findByKey(r, context, AUTO_TIME_TRACKING_MAX_IDLE_KEY),
    ]);
    return {
      policy: storedAutoTrackingPolicy(policy?.settingValue),
      maxIdleMinutes: storedMaxIdleMinutes(maxIdle?.settingValue),
    };
  }

  private async view(
    r: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    rules: CompanyRules,
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
      policy: rules.policy,
      enabled: effectiveEnabled(rules.policy, ownSwitch),
      ownSwitch,
      idleThresholdMinutes: rules.maxIdleMinutes,
      maxIdleMinutes: rules.maxIdleMinutes,
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
