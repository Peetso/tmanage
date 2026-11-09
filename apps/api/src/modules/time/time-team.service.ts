import { authorize, dayNumberOf } from '@tmanage/domain';
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
  storedAutoTrackingPolicy,
} from '../tenancy/auto-time-tracking-policy.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { TIME_VIEW_TEAM, requireInternal } from './time-capabilities.js';
import { automaticMinutes, effectiveEnabled, isLive } from './time-auto-rules.js';
import type { TimeAutoRepository } from './time-auto.repository.js';
import { optionalId, periodContaining, utcDay } from './time-rules.js';
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
 * - **What.** State, times and the task. No screenshots, keystrokes, app or window names or URLs
 *   exist to show. Read-only: corrections stay in the timesheet (manager edits, 52-02).
 *
 * Days are UTC calendar days, the `spent_on` every timed entry is filed under.
 */

/** A range covers at most this many days. */
export const MAX_RANGE_DAYS = 62;

export type LiveState = 'tracking' | 'paused' | 'manual' | 'off';

export interface TeamTaskView {
  readonly workItemId: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
}

export interface TeamPersonView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly live: LiveState;
  readonly currentTask: TeamTaskView | null;
  readonly todayMinutes: number;
  readonly weekMinutes: number;
  readonly rangeMinutes: number;
}

export interface TeamTimeView {
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly week: WeekBounds;
  readonly policy: AutoTrackingPolicy;
  readonly people: readonly TeamPersonView[];
  readonly totals: {
    readonly todayMinutes: number;
    readonly weekMinutes: number;
    readonly rangeMinutes: number;
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
  readonly needsReview: boolean;
  readonly open: boolean;
}

export interface TeamDayView {
  readonly membershipId: string;
  readonly displayName: string;
  readonly day: string;
  readonly sessions: readonly TeamSessionView[];
  readonly totalMinutes: number;
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

/** The open session's evidence-supported part, as a not-yet-filed piece. */
function openPiece(row: TimeAutoTrackingRow): { startedAt: Date; endedAt: Date } | null {
  if (row.sessionStartedAt === null || row.lastActiveAt === null) return null;
  return { startedAt: row.sessionStartedAt, endedAt: row.lastActiveAt };
}

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
    const at = this.now();
    const today = utcDay(at);
    const o = this.options;
    return o.database.read(context, async (r) => {
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
      const [names, rows, timers, entries, policy] = await Promise.all([
        o.auto.memberNames(r, context, members),
        o.auto.listForMembers(r, context, members),
        o.timers.listRunning(r, context, null),
        o.sheets.entriesInPeriod(r, context, members, span),
        this.policyOn(r, context),
      ]);
      const nameOf = new Map(names.map((n) => [n.membershipId, n.displayName]));
      const rowOf = new Map(rows.map((row) => [row.membershipId, row]));
      const timerOf = new Map(timers.map((t) => [t.membershipId, t]));
      const titles = await o.sheets.titles(r, context, [
        ...rows.flatMap((row) => (row.workItemId === null ? [] : [row.workItemId])),
        ...timers.flatMap((t) => (t.workItemId === null ? [] : [t.workItemId])),
      ]);
      const matches = (projectId: string | null) =>
        projectFilter === null || projectId === projectFilter;
      const inRange = (day: string, a: string, b: string) => day >= a && day <= b;

      const people: TeamPersonView[] = [];
      for (const membershipId of members) {
        if (!nameOf.has(membershipId)) continue; // not a membership of this company
        const row = rowOf.get(membershipId) ?? null;
        const timer = timerOf.get(membershipId) ?? null;
        const days: { day: string; minutes: number }[] = entries
          .filter((e) => e.loggedBy === membershipId && matches(e.projectId))
          .map((e) => ({ day: e.spentOn, minutes: e.minutes }));
        const piece = row === null ? null : openPiece(row);
        if (row !== null && piece !== null && matches(row.projectId)) {
          days.push({ day: utcDay(piece.startedAt), minutes: automaticMinutes(piece) });
        }
        const sum = (a: string, b: string) =>
          days.filter((d) => inRange(d.day, a, b)).reduce((total, d) => total + d.minutes, 0);
        people.push({
          membershipId,
          displayName: nameOf.get(membershipId) ?? '',
          live: liveState(policy, row, timer, at),
          currentTask: taskOf(row, timer, titles),
          todayMinutes: sum(today, today),
          weekMinutes: sum(week.periodStart, week.periodEnd),
          rangeMinutes: sum(from, to),
        });
      }
      people.sort((a, b) => a.displayName.localeCompare(b.displayName));
      const total = (key: 'todayMinutes' | 'weekMinutes' | 'rangeMinutes') =>
        people.reduce((sum, person) => sum + person[key], 0);
      return {
        from,
        to,
        today,
        week,
        policy,
        people,
        totals: {
          todayMinutes: total('todayMinutes'),
          weekMinutes: total('weekMinutes'),
          rangeMinutes: total('rangeMinutes'),
        },
        serverNow: at.toISOString(),
      };
    });
  }

  /** One person's sessions on one day: start, end, task, automatic or manual. */
  async day(
    context: TenantContext,
    principal: Principal,
    membershipIdRaw: string,
    dayRaw: unknown,
  ): Promise<TeamDayView> {
    requireTeamView(principal, context);
    const membershipId = optionalId(membershipIdRaw, 'membershipId');
    if (membershipId === null) throw notFound();
    const at = this.now();
    const day = optionalDay(dayRaw, 'day') ?? utcDay(at);
    const o = this.options;
    return o.database.read(context, async (r) => {
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
      const piece = row === null ? null : openPiece(row);
      const openToday = row !== null && piece !== null && utcDay(piece.startedAt) === day;
      const titles = await o.sheets.titles(r, context, [
        ...entries.flatMap((e) => (e.workItemId === null ? [] : [e.workItemId])),
        ...(openToday && row.workItemId !== null ? [row.workItemId] : []),
      ]);
      const sessions: TeamSessionView[] = entries.map((e) => sessionOf(e, titles));
      if (openToday && piece !== null) {
        sessions.push({
          id: null,
          startedAt: piece.startedAt.toISOString(),
          endedAt: piece.endedAt.toISOString(),
          minutes: automaticMinutes(piece),
          source: 'automatic',
          workItemId: row.workItemId,
          workItemTitle: row.workItemId === null ? null : (titles.get(row.workItemId) ?? null),
          projectId: row.projectId,
          needsReview: false,
          open: true,
        });
      }
      sessions.sort((a, b) => (a.startedAt ?? '9').localeCompare(b.startedAt ?? '9'));
      return {
        membershipId,
        displayName: name.displayName,
        day,
        sessions,
        totalMinutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
      };
    });
  }

  private async policyOn(
    r: TenantQueryRunner,
    context: TenantContext,
  ): Promise<AutoTrackingPolicy> {
    const row = await this.options.settings.findByKey(r, context, AUTO_TIME_TRACKING_KEY);
    return storedAutoTrackingPolicy(row?.settingValue);
  }
}

function liveState(
  policy: AutoTrackingPolicy,
  row: TimeAutoTrackingRow | null,
  timer: TimeTimerRow | null,
  at: Date,
): LiveState {
  if (timer !== null) return 'manual';
  if (row === null || !effectiveEnabled(policy, row.enabled)) return 'off';
  if (
    row.sessionStartedAt !== null &&
    row.lastActiveAt !== null &&
    row.lastHeartbeatAt !== null &&
    isLive(
      {
        startedAt: row.sessionStartedAt,
        lastActiveAt: row.lastActiveAt,
        lastHeartbeatAt: row.lastHeartbeatAt,
      },
      at,
    ) &&
    at.getTime() - row.lastActiveAt.getTime() < row.idleThresholdMinutes * 60_000
  ) {
    return 'tracking';
  }
  return 'paused';
}

function taskOf(
  row: TimeAutoTrackingRow | null,
  timer: TimeTimerRow | null,
  titles: ReadonlyMap<string, string>,
): TeamTaskView | null {
  const source = timer ?? row;
  if (source === null || (source.workItemId === null && source.projectId === null)) return null;
  return {
    workItemId: source.workItemId,
    projectId: source.projectId,
    title: source.workItemId === null ? null : (titles.get(source.workItemId) ?? null),
  };
}

function sessionOf(e: WorkItemTimeLogRow, titles: ReadonlyMap<string, string>): TeamSessionView {
  return {
    id: e.id,
    startedAt: e.startedAt?.toISOString() ?? null,
    endedAt: e.endedAt?.toISOString() ?? null,
    minutes: e.minutes,
    source: e.source,
    workItemId: e.workItemId,
    workItemTitle: e.workItemId === null ? null : (titles.get(e.workItemId) ?? null),
    projectId: e.projectId,
    needsReview: e.needsReview,
    open: false,
  };
}
