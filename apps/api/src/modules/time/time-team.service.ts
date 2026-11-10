import { authorize, dayNumberOf, localDateOf } from '@tmanage/domain';
import type { AutoTrackingPolicy, Principal } from '@tmanage/domain';
import type {
  TimeAutoTrackingRow,
  TimeTimerRow,
  WorkItemTimeLogRow,
} from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  AUTO_TIME_TRACKING_KEY,
  AUTO_TIME_TRACKING_MAX_IDLE_KEY,
  storedAutoTrackingPolicy,
  storedMaxIdleMinutes,
} from '../tenancy/auto-time-tracking-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { TIME_VIEW_TEAM, mayTrackOnProject, requireInternal } from './time-capabilities.js';
import { openSessionOf } from './time-auto-filing.js';
import type { AutoTimeFiler } from './time-auto-filing.js';
import {
  automaticMinutes,
  effectiveEnabled,
  effectiveThresholdMinutes,
  inProgress,
  isLive,
} from './time-auto-rules.js';
import type { TimeAutoRepository } from './time-auto.repository.js';
import { optionalId, periodContaining } from './time-rules.js';
import type { TimeLogSource, WeekBounds } from './time-rules.js';
import type { TimesheetsRepository } from './timesheets.repository.js';
import type { TimeRepository } from './time.repository.js';

/**
 * FIX-2026-11-10 — the team time view (Finance → Team time): for every person of THIS company,
 * the live tracking state, the current task, time today, this week and in a chosen range, and a
 * day's sessions.
 *
 * - **Who.** Holders of `time.view_team`: the owner, org admins and workspace admins by role, and
 *   anyone an admin granted it (a custom role or a per-person override, both audited). Checked by
 *   the route guard and again here; everyone else is a 403 and sees only their own time.
 * - **Which people.** Only active internal memberships of the caller's organization (the
 *   `TenantContext`): every statement carries its `organization_id`, and a person id from another
 *   company is the same 404 as one that does not exist.
 * - **Which tasks** (review M1). A task or project title shows only where the viewer may read that
 *   project themself (the same project check the timer presence uses); anywhere else the time is
 *   still counted, shown as a private task with no title and no ids. A project filter the viewer
 *   cannot read is a 404.
 * - **Which totals** (review L6). Today, week and range are filed entries only, the figures the
 *   timesheet shows; a live session's time so far is reported apart as "in progress". A session
 *   no heartbeat can extend any more is settled (filed) before every read, so nothing silent is
 *   counted (review M5).
 * - **Which days** (review M4). The company's calendar days in its time zone.
 * - **What.** State, times and the task. No screenshots, keystrokes, app or window names or URLs
 *   exist to show. Automatic time is reported by the person's device; a flagged entry
 *   (`needsReview`) is marked. Read-only: corrections stay in the timesheet (52-02).
 */

/** A range covers at most this many days. */
export const MAX_RANGE_DAYS = 62;

export type LiveState = 'tracking' | 'paused' | 'manual' | 'off';

export interface TeamTaskView {
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  /** The viewer may not read this task's project: no title, no ids. */
  readonly private: boolean;
}

export interface TeamPersonView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly live: LiveState;
  readonly currentTask: TeamTaskView | null;
  readonly todayMinutes: number;
  readonly weekMinutes: number;
  readonly rangeMinutes: number;
  /** A live session's time so far, not yet in the totals. */
  readonly inProgressMinutes: number;
  /** An entry in the range is flagged for review. */
  readonly needsReview: boolean;
}

export interface TeamTimeView {
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly week: WeekBounds;
  readonly timeZone: string;
  readonly policy: AutoTrackingPolicy;
  readonly people: readonly TeamPersonView[];
  readonly totals: {
    readonly todayMinutes: number;
    readonly weekMinutes: number;
    readonly rangeMinutes: number;
    readonly inProgressMinutes: number;
  };
  readonly serverNow: string;
}

export interface TeamSessionView {
  /** The entry id, or null for the session still open. */
  readonly id: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly minutes: number;
  readonly source: TimeLogSource;
  readonly workItemId: string | null;
  readonly workItemTitle: string | null;
  readonly projectId: string | null;
  /** The viewer may not read this entry's project: no title, no ids. */
  readonly private: boolean;
  readonly needsReview: boolean;
  /** Filed late (its week was closed): the company day it really happened on. */
  readonly lateFrom: string | null;
  readonly open: boolean;
}

export interface TeamDayView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly day: string;
  readonly timeZone: string;
  readonly sessions: readonly TeamSessionView[];
  /** Filed time of the day (the timesheet's figure). */
  readonly totalMinutes: number;
  readonly inProgressMinutes: number;
}

export interface TimeTeamServiceOptions {
  readonly database: Pick<TenantDatabase, 'read'>;
  readonly auto: Pick<TimeAutoRepository, 'listForMembers' | 'memberNames'>;
  readonly sheets: Pick<
    TimesheetsRepository,
    'weekStart' | 'internalMembers' | 'entriesInPeriod' | 'titles'
  >;
  readonly timers: Pick<TimeRepository, 'listRunning'>;
  readonly settings: Pick<OrgSettingsRepository, 'findByKey'>;
  readonly filer: Pick<AutoTimeFiler, 'settleStale' | 'timeZone'>;
  readonly now?: () => Date;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message }]);
}

function optionalDay(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (
    typeof raw !== 'string' ||
    !ISO_DAY.test(raw) ||
    Number.isNaN(Date.parse(`${raw}T00:00:00Z`))
  ) {
    throw invalid(field, 'must be a date like 2026-11-10');
  }
  return raw;
}

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);

/** The org-wide `time.view_team` decision, made again behind the route guard. */
export function requireTeamView(principal: Principal, context: TenantContext): void {
  requireInternal(principal);
  const verdict = authorize({
    principal,
    capability: TIME_VIEW_TEAM,
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
      `time_team:${verdict.code}`,
    );
  }
  if (principal.organizationId !== context.organizationId) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'time_team:other_tenant');
  }
}

/** What the viewer may see of a project's tasks (review M1). */
type ProjectVisible = (projectId: string | null) => boolean;

export class TimeTeamService {
  private readonly now: () => Date;

  constructor(private readonly options: TimeTeamServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(
    context: TenantContext,
    principal: Principal,
    query: {
      readonly from?: unknown;
      readonly to?: unknown;
      readonly membershipId?: unknown;
      readonly projectId?: unknown;
    },
  ): Promise<TeamTimeView> {
    requireTeamView(principal, context);
    const fromRaw = optionalDay(query.from, 'from');
    const toRaw = optionalDay(query.to, 'to');
    const membershipFilter = optionalId(query.membershipId, 'membershipId');
    const projectFilter = optionalId(query.projectId, 'projectId');
    const visible = visibilityFor(principal, context);
    if (projectFilter !== null && !visible(projectFilter)) throw notFound();
    const o = this.options;
    await o.filer.settleStale(context, null);
    const at = this.now();
    return o.database.read(context, async (r) => {
      const timeZone = await o.filer.timeZone(r, context);
      const today = localDateOf(at, timeZone);
      const week = periodContaining(today, await o.sheets.weekStart(r, context));
      const from = fromRaw ?? week.periodStart;
      const to = toRaw ?? week.periodEnd;
      if (to < from) throw invalid('to', 'must not be before from');
      if (dayNumberOf(to) - dayNumberOf(from) + 1 > MAX_RANGE_DAYS) {
        throw invalid('to', `a range covers at most ${MAX_RANGE_DAYS} days`);
      }
      let members = (await o.sheets.internalMembers(r, context)).map((m) => m.membershipId);
      if (membershipFilter !== null) {
        if (!members.includes(membershipFilter)) throw notFound();
        members = [membershipFilter];
      }
      const span: WeekBounds = {
        periodStart: [from, week.periodStart, today].sort()[0] ?? from,
        periodEnd: [to, week.periodEnd, today].sort().reverse()[0] ?? to,
      };
      const [names, rows, timers, entries, rules] = await Promise.all([
        o.auto.memberNames(r, context, members),
        o.auto.listForMembers(r, context, members),
        o.timers.listRunning(r, context, null),
        o.sheets.entriesInPeriod(r, context, members, span),
        this.rulesOn(r, context),
      ]);
      const nameOf = new Map(names.map((n) => [n.membershipId, n.displayName]));
      const rowOf = new Map(rows.map((row) => [row.membershipId, row]));
      const timerOf = new Map(timers.map((t) => [t.membershipId, t]));
      const titles = await o.sheets.titles(r, context, [
        ...rows.flatMap((row) =>
          row.workItemId !== null && visible(row.projectId) ? [row.workItemId] : [],
        ),
        ...timers.flatMap((t) =>
          t.workItemId !== null && visible(t.projectId) ? [t.workItemId] : [],
        ),
      ]);
      const matches = (projectId: string | null) =>
        projectFilter === null || projectId === projectFilter;
      const inRange = (day: string, a: string, b: string) => day >= a && day <= b;

      const people: TeamPersonView[] = [];
      for (const membershipId of members) {
        if (!nameOf.has(membershipId)) continue; // not a membership of this company
        const row = rowOf.get(membershipId) ?? null;
        const timer = timerOf.get(membershipId) ?? null;
        const own = entries.filter((e) => e.loggedBy === membershipId && matches(e.projectId));
        const sum = (a: string, b: string) =>
          own.filter((e) => inRange(e.spentOn, a, b)).reduce((total, e) => total + e.minutes, 0);
        const piece =
          row !== null && matches(row.projectId) ? inProgress(openSessionOf(row), at) : null;
        people.push({
          membershipId,
          displayName: nameOf.get(membershipId) ?? '',
          live: liveState(rules, row, timer, at),
          currentTask: taskOf(row, timer, titles, visible),
          todayMinutes: sum(today, today),
          weekMinutes: sum(week.periodStart, week.periodEnd),
          rangeMinutes: sum(from, to),
          inProgressMinutes: piece === null ? 0 : automaticMinutes(piece),
          needsReview: own.some((e) => e.needsReview && inRange(e.spentOn, from, to)),
        });
      }
      people.sort((a, b) => a.displayName.localeCompare(b.displayName));
      const total = (key: 'todayMinutes' | 'weekMinutes' | 'rangeMinutes' | 'inProgressMinutes') =>
        people.reduce((sum, person) => sum + person[key], 0);
      return {
        from,
        to,
        today,
        week,
        timeZone,
        policy: rules.policy,
        people,
        totals: {
          todayMinutes: total('todayMinutes'),
          weekMinutes: total('weekMinutes'),
          rangeMinutes: total('rangeMinutes'),
          inProgressMinutes: total('inProgressMinutes'),
        },
        serverNow: at.toISOString(),
      };
    });
  }

  /** One person's sessions on one company day: start, end, task, automatic or manual. */
  async day(
    context: TenantContext,
    principal: Principal,
    membershipIdRaw: string,
    dayRaw: unknown,
  ): Promise<TeamDayView> {
    requireTeamView(principal, context);
    const membershipId = optionalId(membershipIdRaw, 'membershipId');
    if (membershipId === null) throw notFound();
    const dayInput = optionalDay(dayRaw, 'day');
    const visible = visibilityFor(principal, context);
    const o = this.options;
    await o.filer.settleStale(context, [membershipId]);
    const at = this.now();
    return o.database.read(context, async (r) => {
      const timeZone = await o.filer.timeZone(r, context);
      const day = dayInput ?? localDateOf(at, timeZone);
      const members = await o.sheets.internalMembers(r, context);
      if (!members.some((m) => m.membershipId === membershipId)) throw notFound();
      const [names, rows, entries] = await Promise.all([
        o.auto.memberNames(r, context, [membershipId]),
        o.auto.listForMembers(r, context, [membershipId]),
        o.sheets.entriesInPeriod(r, context, [membershipId], { periodStart: day, periodEnd: day }),
      ]);
      const name = names[0];
      if (name === undefined) throw notFound();
      const row = rows[0] ?? null;
      const live = row === null ? null : inProgress(openSessionOf(row), at);
      const piece = live !== null && localDateOf(live.startedAt, timeZone) === day ? live : null;
      const titles = await o.sheets.titles(r, context, [
        ...entries.flatMap((e) =>
          e.workItemId !== null && visible(e.projectId) ? [e.workItemId] : [],
        ),
        ...(piece !== null && row?.workItemId && visible(row.projectId) ? [row.workItemId] : []),
      ]);
      const sessions: TeamSessionView[] = entries.map((e) =>
        sessionOf(e, titles, visible, timeZone),
      );
      if (piece !== null && row !== null) {
        const shown = visible(row.projectId);
        sessions.push({
          id: null,
          startedAt: piece.startedAt.toISOString(),
          endedAt: piece.endedAt.toISOString(),
          minutes: automaticMinutes(piece),
          source: 'automatic',
          workItemId: shown ? row.workItemId : null,
          workItemTitle:
            shown && row.workItemId !== null ? (titles.get(row.workItemId) ?? null) : null,
          projectId: shown ? row.projectId : null,
          private: !shown && (row.workItemId !== null || row.projectId !== null),
          needsReview: false,
          lateFrom: null,
          open: true,
        });
      }
      sessions.sort((a, b) => (a.startedAt ?? '9').localeCompare(b.startedAt ?? '9'));
      return {
        membershipId,
        displayName: name.displayName,
        day,
        timeZone,
        sessions,
        totalMinutes: entries.reduce((sum, e) => sum + e.minutes, 0),
        inProgressMinutes: piece === null ? 0 : automaticMinutes(piece),
      };
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
}

/** The viewer's own project read (the check the timer presence uses), per project. */
function visibilityFor(principal: Principal, context: TenantContext): ProjectVisible {
  const known = new Map<string, boolean>();
  return (projectId) => {
    if (projectId === null) return false;
    let seen = known.get(projectId);
    if (seen === undefined) {
      seen = mayTrackOnProject(principal, context, projectId);
      known.set(projectId, seen);
    }
    return seen;
  };
}

interface CompanyRules {
  readonly policy: AutoTrackingPolicy;
  readonly maxIdleMinutes: number;
}

function liveState(
  { policy, maxIdleMinutes }: CompanyRules,
  row: TimeAutoTrackingRow | null,
  timer: TimeTimerRow | null,
  at: Date,
): LiveState {
  if (timer !== null) return 'manual';
  if (row === null || !effectiveEnabled(policy, row.enabled)) return 'off';
  const session = openSessionOf(row);
  if (
    session !== null &&
    isLive(session, at) &&
    at.getTime() - session.lastActiveAt.getTime() <
      effectiveThresholdMinutes(row.idleThresholdMinutes, maxIdleMinutes) * 60_000
  ) {
    return 'tracking';
  }
  return 'paused';
}

function taskOf(
  row: TimeAutoTrackingRow | null,
  timer: TimeTimerRow | null,
  titles: ReadonlyMap<string, string>,
  visible: ProjectVisible,
): TeamTaskView | null {
  const source = timer ?? row;
  if (source === null || (source.workItemId === null && source.projectId === null)) return null;
  if (!visible(source.projectId)) {
    return { workItemId: null, projectId: null, title: null, private: true };
  }
  return {
    workItemId: source.workItemId,
    projectId: source.projectId,
    title: source.workItemId === null ? null : (titles.get(source.workItemId) ?? null),
    private: false,
  };
}

function sessionOf(
  e: WorkItemTimeLogRow,
  titles: ReadonlyMap<string, string>,
  visible: ProjectVisible,
  timeZone: string,
): TeamSessionView {
  const shown = visible(e.projectId);
  const trackedOn =
    e.source === 'automatic' && e.startedAt !== null ? localDateOf(e.startedAt, timeZone) : null;
  return {
    id: e.id,
    startedAt: e.startedAt?.toISOString() ?? null,
    endedAt: e.endedAt?.toISOString() ?? null,
    minutes: e.minutes,
    source: e.source,
    workItemId: shown ? e.workItemId : null,
    workItemTitle: shown && e.workItemId !== null ? (titles.get(e.workItemId) ?? null) : null,
    projectId: shown ? e.projectId : null,
    private: !shown && (e.workItemId !== null || e.projectId !== null),
    needsReview: e.needsReview,
    lateFrom: trackedOn !== null && trackedOn !== e.spentOn ? trackedOn : null,
    open: false,
  };
}
