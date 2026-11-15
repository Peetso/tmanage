import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TimeAutoTrackingRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  applyHeartbeat,
  automaticMinutes,
  boundAutomaticDay,
  freeSpans,
  settle,
  splitByLocalDay,
} from './time-auto-rules.js';
import type { OpenSession } from './time-auto-rules.js';
import { AutoTimeFiler } from './time-auto-filing.js';
import type { AutoTimeFilerOptions } from './time-auto-filing.js';
import { InProcessAutoLimiter } from './time-auto-limits.js';
import { TimeAutoService } from './time-auto.service.js';
import type { TimeAutoServiceOptions } from './time-auto.service.js';

/**
 * FIX-2026-11-10 — automatic tracking: the server's heartbeat rules and the service's refusals,
 * over in-memory fakes (no database). The client never sends a time; these prove a client cannot
 * make one up either: no future, no overlap, no session longer than its heartbeats.
 */

const T0 = new Date('2026-11-10T09:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const THRESHOLD = 300;

/** Run heartbeats `[secondsAfterT0, idleSeconds]` and collect the closed sessions. */
function feed(beats: readonly (readonly [number, number])[], start: OpenSession | null = null) {
  let session = start;
  const closed: { startedAt: Date; endedAt: Date }[] = [];
  for (const [seconds, idle] of beats) {
    const out = applyHeartbeat(session, at(seconds), idle, THRESHOLD);
    if (out.closed) closed.push(out.closed);
    session = out.open;
  }
  return { session, closed };
}

describe('heartbeats into sessions', () => {
  it('joins heartbeats a minute apart into one session from the first to the last input', () => {
    const { session, closed } = feed([
      [0, 3],
      [60, 0],
      [120, 10],
      [180, 1],
    ]);
    expect(closed).toEqual([]);
    expect(session?.startedAt).toEqual(at(-3));
    expect(session?.lastActiveAt).toEqual(at(179));
  });

  it('idle trimming: the session ends at the last real input, not when idleness was reported', () => {
    // Last input at 120 s; the tracker keeps reporting a growing idle time, then "idle 300 s".
    const { session, closed } = feed([
      [0, 0],
      [60, 0],
      [120, 0],
      [180, 60],
      [240, 120],
      [300, 180],
      [360, 240],
      [420, 300],
    ]);
    expect(closed).toEqual([]);
    expect(session?.lastActiveAt).toEqual(at(120));
    // Back after the idle stretch: the old session closes at 120 s, a new one starts at 480 s.
    const back = feed([[480, 0]], session);
    expect(back.closed).toEqual([{ startedAt: at(0), endedAt: at(120) }]);
    expect(back.session?.startedAt).toEqual(at(480));
  });

  it('lock or sleep: a silent gap longer than 150 s ends the session at its last activity', () => {
    const { closed, session } = feed([
      [0, 0],
      [60, 0],
      [3600, 0],
    ]);
    expect(closed).toEqual([{ startedAt: at(0), endedAt: at(60) }]);
    expect(session?.startedAt).toEqual(at(3600));
    expect(
      settle({ startedAt: at(0), lastActiveAt: at(60), lastHeartbeatAt: at(60) }, at(400)),
    ).toEqual({ startedAt: at(0), endedAt: at(60) });
    expect(
      settle({ startedAt: at(0), lastActiveAt: at(60), lastHeartbeatAt: at(60) }, at(120)),
    ).toBeNull();
  });

  it('two devices count once: interleaved heartbeats extend one session, an idle one cannot shorten it', () => {
    const { closed, session } = feed([
      [0, 0], // laptop
      [30, 0], // desktop
      [60, 0], // laptop
      [90, 0], // desktop
      [100, 400], // laptop went idle long ago: cannot move the end backwards
      [150, 0], // desktop still active
    ]);
    expect(closed).toEqual([]);
    expect(session?.startedAt).toEqual(at(0));
    expect(session?.lastActiveAt).toEqual(at(150));
  });

  it('never in the future and never longer than the evidence', () => {
    // A client claiming "idle 0" every 10 minutes gets points, not a 30-minute session.
    const sparse = feed([
      [0, 0],
      [600, 0],
      [1200, 0],
    ]);
    expect(sparse.closed).toEqual([
      { startedAt: at(0), endedAt: at(0) },
      { startedAt: at(600), endedAt: at(600) },
    ]);
    expect(sparse.session?.lastActiveAt.getTime()).toBeLessThanOrEqual(at(1200).getTime());
    // A negative or huge idle value never moves the last activity past the server clock.
    const out = applyHeartbeat(null, at(0), -50, THRESHOLD);
    expect(out.open?.lastActiveAt.getTime()).toBeLessThanOrEqual(at(0).getTime());
    // A session is cut at 24 hours.
    const day: [number, number][] = [];
    for (let s = 0; s <= 86_460; s += 60) day.push([s, 0]);
    expect(feed(day).closed).toHaveLength(1);
  });

  it('a new session never starts before the previous one ended', () => {
    const start = { startedAt: at(0), lastActiveAt: at(100), lastHeartbeatAt: at(100) };
    // 260 s later (gap too long) with "idle 200 s": activity at 60 s, inside the closed session.
    const out = applyHeartbeat(start, at(260), 200, THRESHOLD);
    expect(out.closed).toEqual({ startedAt: at(0), endedAt: at(100) });
    expect(out.open?.startedAt).toEqual(at(100));
  });

  it('overlap: only stretches no other timed entry covers are filed; a running timer covers the rest', () => {
    const span = { startedAt: at(0), endedAt: at(3600) };
    expect(
      freeSpans(span, [
        { startedAt: at(600), endedAt: at(1200) },
        { startedAt: at(3000), endedAt: null },
      ]),
    ).toEqual([
      { startedAt: at(0), endedAt: at(600) },
      { startedAt: at(1200), endedAt: at(3000) },
    ]);
    expect(freeSpans(span, [{ startedAt: at(-60), endedAt: at(4000) }])).toEqual([]);
    expect(automaticMinutes({ startedAt: at(0), endedAt: at(89) })).toBe(1);
    expect(automaticMinutes({ startedAt: at(0), endedAt: at(29) })).toBe(0);
  });
});

// ---- the service ----

const me = { organizationId: 'o1', userId: 'u1', membershipId: 'm1' } as TenantContext;
const member = {
  kind: 'internal',
  role: 'member',
  organizationId: 'o1',
  userId: 'u1',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: false,
} as unknown as Principal;

/** The same member, on project p1. */
const onP1 = { ...member, projectIds: ['p1'] } as unknown as Principal;
const ITEM_W1 = {
  id: 'w1',
  organizationId: 'o1',
  projectId: 'p1',
  audience: 'internal',
  state: 'open',
  deletedAt: null,
};

function row(o: Partial<TimeAutoTrackingRow> = {}): TimeAutoTrackingRow {
  return {
    id: 'r1',
    organizationId: 'o1',
    membershipId: 'm1',
    userId: 'u1',
    enabled: true,
    idleThresholdMinutes: 5,
    workItemId: null,
    projectId: null,
    sessionStartedAt: null,
    lastActiveAt: null,
    lastHeartbeatAt: null,
    deviceKind: null,
    deviceSeenAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...o,
  };
}

interface HarnessOptions {
  readonly row?: TimeAutoTrackingRow;
  readonly others?: readonly TimeAutoTrackingRow[];
  readonly policy?: string;
  readonly maxIdle?: string;
  readonly timeZone?: string;
  readonly busy?: unknown[];
  readonly nowS?: number;
  readonly locks?: readonly { periodStart: string; periodEnd: string; unlockedAt: null }[];
  readonly sheetState?: string;
  readonly items?: Record<string, unknown>;
  readonly earlier?: readonly Record<string, unknown>[];
  readonly limiter?: unknown;
}

function harness(o: HarnessOptions = {}) {
  const rows = new Map<string, TimeAutoTrackingRow>();
  for (const r of [o.row ?? row(), ...(o.others ?? [])]) rows.set(r.id, r);
  const entries: Record<string, unknown>[] = [...(o.earlier ?? [])];
  const audits: Record<string, unknown>[] = [];
  const limiterCalls: string[] = [];
  const settings = new Map<string, string>();
  if (o.policy) settings.set('auto_time_tracking', o.policy);
  if (o.maxIdle) settings.set('auto_time_tracking_max_idle', o.maxIdle);
  if (o.timeZone) settings.set('default_timezone', o.timeZone);
  const now = () => at(o.nowS ?? 0);
  const own = () => [...rows.values()].find((r) => r.membershipId === 'm1') ?? null;
  const database = {
    transaction: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
    read: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
  };
  const update = async (
    _r: unknown,
    _c: unknown,
    id: string,
    patch: Partial<TimeAutoTrackingRow>,
  ) => {
    const current = rows.get(id);
    if (current) rows.set(id, { ...current, ...patch });
  };
  const timers = {
    findTimer: async () => null,
    projectExists: async () => true,
    workItemExists: async () => true,
  };
  const settingsRepo = {
    findByKey: async (_r: unknown, _c: unknown, key: string) =>
      settings.has(key) ? { settingValue: settings.get(key) } : null,
    upsert: async (_r: unknown, _c: unknown, input: { key: string; value: string }) => {
      settings.set(input.key, input.value);
    },
    resolveOrganization: async () => ({ id: 'o1' }),
  };
  const workItems = {
    findById: async (_r: unknown, _c: unknown, id: string) => o.items?.[id] ?? null,
  };
  const audit = {
    record: async (_r: unknown, _c: unknown, entry: Record<string, unknown>) => {
      audits.push(entry);
    },
  };
  const filer = new AutoTimeFiler({
    now,
    database,
    repository: {
      timedEntriesOverlapping: async () => o.busy ?? [],
      automaticMinutesBetween: async (
        _r: unknown,
        _c: unknown,
        membershipId: string,
        from: Date,
        to: Date,
      ) =>
        entries
          .filter(
            (e) =>
              e['loggedBy'] === membershipId &&
              e['source'] === 'automatic' &&
              (e['startedAt'] as Date) >= from &&
              (e['startedAt'] as Date) < to,
          )
          .reduce((sum, e) => sum + (e['minutes'] as number), 0),
      staleSessions: async (_r: unknown, _c: unknown, ids: readonly string[] | null, when: Date) =>
        [...rows.values()].filter(
          (r) =>
            (ids === null || ids.includes(r.membershipId)) &&
            r.sessionStartedAt !== null &&
            r.lastHeartbeatAt !== null &&
            (when.getTime() - r.lastHeartbeatAt.getTime() > 150_000 ||
              when.getTime() - r.sessionStartedAt.getTime() >= 86_400_000),
        ),
      openSessions: async () => [...rows.values()].filter((r) => r.sessionStartedAt !== null),
      update,
    },
    timers,
    sheets: {
      weekStart: async () => 1,
      openLocks: async () => o.locks ?? [],
      findForMember: async () => (o.sheetState ? { state: o.sheetState } : null),
    },
    settings: settingsRepo,
    timeLogs: {
      create: async (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
        entries.push(input);
        return { id: `e${entries.length}` };
      },
    },
    workItems,
    audit,
  } as unknown as AutoTimeFilerOptions);
  const options = {
    now,
    database,
    repository: { find: async () => own(), ensureOwn: async () => own(), update },
    timers,
    settings: settingsRepo,
    workItems,
    audit,
    filer,
    limiter:
      o.limiter === undefined
        ? {
            check: async (_p: unknown, subject: { link: string }) => {
              limiterCalls.push(subject.link);
              return { admitted: limiterCalls.length <= 12 };
            },
          }
        : o.limiter,
  } as unknown as TimeAutoServiceOptions;
  return {
    service: new TimeAutoService(options),
    filer,
    entries,
    audits,
    limiterCalls,
    settings,
    row: () => own() as TimeAutoTrackingRow,
    rowById: (id: string) => rows.get(id),
  };
}

describe('TimeAutoService', () => {
  it('heartbeat: rejects a body that is not whole idle seconds, and never reads a time from it', async () => {
    const { service } = harness();
    for (const bad of [{}, { idleSeconds: -1 }, { idleSeconds: 1.5 }, { idleSeconds: '3' }]) {
      await expect(service.heartbeat(me, member, bad)).rejects.toMatchObject({ status: 400 });
    }
    const view = await service.heartbeat(me, member, {
      idleSeconds: 0,
      startedAt: '2020-01-01T00:00:00Z',
      endedAt: '2099-01-01T00:00:00Z',
      minutes: 9999,
      membershipId: 'm2',
    });
    expect(view.session?.startedAt).toBe(at(0).toISOString());
    expect(view.session?.lastActiveAt).toBe(at(0).toISOString());
  });

  it('files a finished session as automatic time, on the current task, and never in the future', async () => {
    const open = row({
      workItemId: 'w1',
      projectId: 'p1',
      sessionStartedAt: at(-1800),
      lastActiveAt: at(-1200),
      lastHeartbeatAt: at(-1200),
    });
    const { service, entries, row: after } = harness({ row: open, items: { w1: ITEM_W1 } });
    await service.heartbeat(me, onP1, { idleSeconds: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'automatic',
      workItemId: 'w1',
      projectId: 'p1',
      loggedBy: 'm1',
      minutes: 10,
      startedAt: at(-1800),
      endedAt: at(-1200),
    });
    expect((entries[0]?.['endedAt'] as Date).getTime()).toBeLessThanOrEqual(at(0).getTime());
    expect(after().sessionStartedAt).toEqual(at(0));
  });

  it('rejects overlap: a session already covered by a manual entry files nothing', async () => {
    const open = row({
      sessionStartedAt: at(-1800),
      lastActiveAt: at(-1200),
      lastHeartbeatAt: at(-1200),
    });
    const { service, entries } = harness({
      row: open,
      busy: [{ startedAt: at(-2000), endedAt: at(-1000) }],
    });
    await service.heartbeat(me, member, { idleSeconds: 0 });
    expect(entries).toEqual([]);
  });

  it('rejects inflation: a session cannot outlast its heartbeats, whatever idle the client claims', async () => {
    const open = row({
      sessionStartedAt: at(-300),
      lastActiveAt: at(-240),
      lastHeartbeatAt: at(-240),
    });
    const { service, entries } = harness({ row: open });
    // 240 s of silence: "idle 0 now" cannot claim the silent stretch.
    await service.heartbeat(me, member, { idleSeconds: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ minutes: 1, startedAt: at(-300), endedAt: at(-240) });
  });

  it('policy off, or own switch off under optional: refused, and an open session is filed first', async () => {
    const open = row({
      sessionStartedAt: at(-600),
      lastActiveAt: at(-60),
      lastHeartbeatAt: at(-60),
    });
    const off = harness({ row: open, policy: 'off' });
    await expect(off.service.heartbeat(me, member, { idleSeconds: 0 })).rejects.toMatchObject({
      status: 409,
    });
    expect(off.entries).toHaveLength(1);
    expect(off.row().sessionStartedAt).toBeNull();
    const mine = harness({ row: row({ enabled: false }) });
    await expect(mine.service.heartbeat(me, member, { idleSeconds: 0 })).rejects.toMatchObject({
      status: 409,
    });
    const required = harness({ row: row({ enabled: false }), policy: 'required' });
    expect((await required.service.heartbeat(me, member, { idleSeconds: 0 })).enabled).toBe(true);
  });

  it('rate-limits heartbeats per member', async () => {
    const { service, limiterCalls } = harness();
    for (let i = 0; i < 12; i += 1) await service.heartbeat(me, member, { idleSeconds: 0 });
    await expect(service.heartbeat(me, member, { idleSeconds: 0 })).rejects.toMatchObject({
      status: 429,
    });
    expect(new Set(limiterCalls)).toEqual(new Set(['o1:m1']));
  });

  it('only the owner sets the company policy; a client principal never tracks', async () => {
    const { service } = harness();
    const admin = { ...member, role: 'org_admin', hasOrgWideScope: true } as unknown as Principal;
    await expect(service.setPolicy(me, admin, { policy: 'required' })).rejects.toMatchObject({
      status: 403,
    });
    const owner = { ...member, role: 'owner', hasOrgWideScope: true } as unknown as Principal;
    await expect(service.setPolicy(me, owner, { policy: 'sometimes' })).rejects.toMatchObject({
      status: 400,
    });
    expect(await service.setPolicy(me, owner, { policy: 'required' })).toEqual({
      policy: 'required',
      maxIdleMinutes: 5,
    });
    const client = { ...member, kind: 'client' } as unknown as Principal;
    await expect(service.heartbeat(me, client, { idleSeconds: 0 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('settings: only the own switch is personal; the away threshold is the workspace one', async () => {
    const { service, row: after } = harness({
      maxIdle: '7',
      row: row({ idleThresholdMinutes: 2 }),
    });
    const view = await service.updateSettings(me, member, {
      enabled: true,
      idleThresholdMinutes: 10,
    });
    expect(view.idleThresholdMinutes).toBe(7);
    expect(after().idleThresholdMinutes).toBe(2);
    expect(view.visibleTo).toBe('admins_and_authorized');
  });
});

// ---- security review fixes (FIX-2026-11-10) ----

const owner = { ...member, role: 'owner', hasOrgWideScope: true } as unknown as Principal;
const iso = (s: string) => new Date(s);

describe('review M2: "off" really stops tracking', () => {
  it('the owner switching off closes every open session at its last activity', async () => {
    const mine = row({
      sessionStartedAt: at(-600),
      lastActiveAt: at(-60),
      lastHeartbeatAt: at(-60),
    });
    const theirs = row({
      id: 'r2',
      membershipId: 'm2',
      userId: 'u2',
      sessionStartedAt: at(-1200),
      lastActiveAt: at(-300),
      lastHeartbeatAt: at(-30),
    });
    const h = harness({ row: mine, others: [theirs], policy: 'optional' });
    await h.service.setPolicy(me, owner, { policy: 'off' });
    expect(h.entries.map((e) => [e['loggedBy'], e['minutes'], e['endedAt']])).toEqual([
      ['m1', 9, at(-60)],
      ['m2', 15, at(-300)],
    ]);
    expect(h.row().sessionStartedAt).toBeNull();
    expect(h.rowById('r2')?.sessionStartedAt).toBeNull();
    expect(h.audits.at(-1)).toMatchObject({
      action: 'organization.auto_time_tracking_policy_changed',
      actorUserId: 'u1',
      metadata: { previous: 'optional', value: 'off', sessions_closed: 2 },
      changes: [
        { field: 'auto_time_tracking', before: 'optional', after: 'off' },
        { field: 'max_idle_minutes', before: 5, after: 5 },
        { field: 'open_auto_sessions', before: 2, after: 0 },
      ],
    });
  });

  it('"working on now" with tracking off files the open session and opens none', async () => {
    const open = row({
      sessionStartedAt: at(-600),
      lastActiveAt: at(-30),
      lastHeartbeatAt: at(-30),
    });
    const off = harness({ row: open, policy: 'off' });
    await off.service.setCurrentTask(me, member, {});
    expect(off.entries).toHaveLength(1);
    expect(off.row()).toMatchObject({ sessionStartedAt: null, lastHeartbeatAt: null });
    const switchedOff = harness({ row: { ...open, enabled: false } });
    await switchedOff.service.setCurrentTask(me, member, {});
    expect(switchedOff.row().sessionStartedAt).toBeNull();
  });

  it('a task change splits the session at the click and keeps the old heartbeat', async () => {
    const open = row({
      sessionStartedAt: at(-600),
      lastActiveAt: at(-30),
      lastHeartbeatAt: at(-40),
    });
    const h = harness({ row: open });
    await h.service.setCurrentTask(me, member, {});
    expect(h.entries[0]).toMatchObject({ startedAt: at(-600), endedAt: at(0) });
    expect(h.row()).toMatchObject({
      sessionStartedAt: at(0),
      lastActiveAt: at(0),
      lastHeartbeatAt: at(-40),
    });
  });

  it('live check B4: the minute before "Work on this now" stays unassigned', async () => {
    // A session opened at -60 with no task; the task is chosen at 0; the next heartbeat at +60.
    const open = row({
      sessionStartedAt: at(-60),
      lastActiveAt: at(-60),
      lastHeartbeatAt: at(-60),
    });
    const id = '01890000-0000-7000-8000-0000000002a1';
    const h = harness({ row: open, items: { [id]: { ...ITEM_W1, id } } });
    await h.service.setCurrentTask(me, onP1, { workItemId: id });
    expect(h.entries).toEqual([
      expect.objectContaining({ workItemId: null, startedAt: at(-60), endedAt: at(0), minutes: 1 }),
    ]);
    expect(h.row()).toMatchObject({ workItemId: id, sessionStartedAt: at(0) });
  });

  it('a session no heartbeat can extend is filed at its last activity, not at the click', async () => {
    const stale = row({
      sessionStartedAt: at(-900),
      lastActiveAt: at(-600),
      lastHeartbeatAt: at(-600),
    });
    const h = harness({ row: stale });
    await h.service.setCurrentTask(me, member, {});
    expect(h.entries[0]).toMatchObject({ startedAt: at(-900), endedAt: at(-600) });
    expect(h.row().sessionStartedAt).toBeNull();
  });

  it('"working on now" is rate-limited; with no durable limiter an in-process one brakes', async () => {
    const h = harness({ limiter: null });
    for (let i = 0; i < 12; i += 1) await h.service.setCurrentTask(me, member, {});
    await expect(h.service.setCurrentTask(me, member, {})).rejects.toMatchObject({ status: 429 });
    // Heartbeats have their own budget, also braked in-process (review L4).
    for (let i = 0; i < 12; i += 1) await h.service.heartbeat(me, member, { idleSeconds: 0 });
    await expect(h.service.heartbeat(me, member, { idleSeconds: 0 })).rejects.toMatchObject({
      status: 429,
    });
    const limiter = new InProcessAutoLimiter(() => 0);
    const policy = { name: 'x', perMinute: 1, key: 'link' } as const;
    expect((await limiter.check(policy, { link: 'a' })).admitted).toBe(true);
    expect((await limiter.check(policy, { link: 'a' })).admitted).toBe(false);
  });
});

describe('review M3: device-reported hours are bounded and flagged', () => {
  it('caps a company day at 16 hours; flags a day over 12 hours or a session over 6', () => {
    expect(boundAutomaticDay(120, 900, 120)).toEqual({
      minutes: 60,
      capped: true,
      needsReview: true,
    });
    expect(boundAutomaticDay(60, 960, 60)).toEqual({ minutes: 0, capped: true, needsReview: true });
    expect(boundAutomaticDay(120, 660, 120)).toMatchObject({ capped: false, needsReview: true });
    expect(boundAutomaticDay(361, 0, 361)).toMatchObject({ capped: false, needsReview: true });
    expect(boundAutomaticDay(360, 0, 360)).toEqual({
      minutes: 360,
      capped: false,
      needsReview: false,
    });
  });

  it('files the capped amount and the review flag', async () => {
    const earlier = [
      {
        loggedBy: 'm1',
        source: 'automatic',
        minutes: 900,
        startedAt: iso('2026-11-10T00:30:00Z'),
      },
    ];
    const open = row({
      sessionStartedAt: at(-7200),
      lastActiveAt: at(-200),
      lastHeartbeatAt: at(-200),
    });
    const h = harness({ row: open, earlier });
    await h.service.heartbeat(me, member, { idleSeconds: 0 });
    const filed = h.entries.slice(1);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ minutes: 60, needsReview: true, source: 'automatic' });
    expect(h.audits.at(-1)).toMatchObject({ metadata: { capped: 'day_cap' } });
    // A single seven-hour stretch is flagged even on an empty day.
    const long = harness({
      row: row({
        sessionStartedAt: at(-25_400),
        lastActiveAt: at(-200),
        lastHeartbeatAt: at(-200),
      }),
    });
    await long.service.heartbeat(me, member, { idleSeconds: 0 });
    expect(long.entries.length).toBeGreaterThan(0);
    expect(long.entries.every((e) => e['needsReview'] === true)).toBe(true);
  });
});

describe('review M4: company days in the company time zone', () => {
  it('splits a session at local midnight in Cairo, including the night summer time starts', () => {
    const november = splitByLocalDay(
      { startedAt: iso('2026-11-10T21:30:00Z'), endedAt: iso('2026-11-10T22:30:00Z') },
      'Africa/Cairo',
    );
    expect(november.map((p) => [p.day, p.span.startedAt.toISOString()])).toEqual([
      ['2026-11-10', '2026-11-10T21:30:00.000Z'],
      ['2026-11-11', '2026-11-10T22:00:00.000Z'],
    ]);
    // 24 April 2026: Cairo clocks jump from 00:00 to 01:00; local midnight is 22:00 UTC.
    const spring = splitByLocalDay(
      { startedAt: iso('2026-04-23T21:30:00Z'), endedAt: iso('2026-04-23T22:30:00Z') },
      'Africa/Cairo',
    );
    expect(spring.map((p) => [p.day, automaticMinutes(p.span)])).toEqual([
      ['2026-04-23', 30],
      ['2026-04-24', 30],
    ]);
    // In UTC the same stretch is one day.
    expect(
      splitByLocalDay(
        { startedAt: iso('2026-11-10T21:30:00Z'), endedAt: iso('2026-11-10T22:30:00Z') },
        'UTC',
      ),
    ).toHaveLength(1);
  });

  it('files each piece on its own company day', async () => {
    // T0 + 46 800 s = 22:00 UTC = midnight in Cairo.
    const open = row({
      sessionStartedAt: at(45_000),
      lastActiveAt: at(48_600),
      lastHeartbeatAt: at(48_600),
    });
    const h = harness({ row: open, timeZone: 'Africa/Cairo', nowS: 49_000 });
    await h.service.heartbeat(me, member, { idleSeconds: 0 });
    expect(h.entries.map((e) => [e['spentOn'], e['minutes']])).toEqual([
      ['2026-11-10', 30],
      ['2026-11-11', 30],
    ]);
  });
});

describe('review M5: silent sessions close without waiting, never into a closed week', () => {
  it('a reader settles a silent session at its last activity', async () => {
    const silent = row({
      sessionStartedAt: at(-1800),
      lastActiveAt: at(-900),
      lastHeartbeatAt: at(-900),
    });
    const h = harness({ row: silent });
    const view = await h.service.get(me, member);
    expect(h.entries).toEqual([
      expect.objectContaining({ minutes: 15, startedAt: at(-1800), endedAt: at(-900) }),
    ]);
    expect(view.session).toBeNull();
    // A session with a recent heartbeat is left alone.
    const live = harness({
      row: row({ sessionStartedAt: at(-600), lastActiveAt: at(-30), lastHeartbeatAt: at(-30) }),
    });
    await live.filer.settleStale(me, null);
    expect(live.entries).toEqual([]);
  });

  it('a locked week is never filed into: the time is late, unassigned and flagged', async () => {
    const silent = row({
      workItemId: 'w1',
      projectId: 'p1',
      sessionStartedAt: at(-1800),
      lastActiveAt: at(-900),
      lastHeartbeatAt: at(-900),
    });
    const lock = { periodStart: '2026-11-09', periodEnd: '2026-11-15', unlockedAt: null };
    const h = harness({ row: silent, locks: [lock], items: { w1: ITEM_W1 } });
    await h.filer.settleStale(me, null);
    expect(h.entries).toEqual([
      expect.objectContaining({
        spentOn: '2026-11-16',
        workItemId: null,
        projectId: null,
        needsReview: true,
        startedAt: at(-1800),
      }),
    ]);
    expect(h.audits[0]).toMatchObject({ metadata: { late_from: '2026-11-10' } });
    // An approved timesheet closes the day the same way.
    const approved = harness({ row: silent, sheetState: 'approved' });
    await approved.filer.settleStale(me, null);
    expect(approved.entries[0]).toMatchObject({ workItemId: null, needsReview: true });
  });
});

describe('item 17: where tracking runs', () => {
  it('stores only a known device word on the caller’s own row, with the server clock', async () => {
    const h = harness();
    await expect(h.service.reportDevice(me, member, { device: 'laptop' })).rejects.toMatchObject({
      status: 400,
    });
    // The old web body `{ kind }` is refused: the field is the shared schema's `device`.
    await expect(h.service.reportDevice(me, member, { kind: 'desktop' })).rejects.toMatchObject({
      status: 400,
    });
    expect(await h.service.reportDevice(me, member, { device: 'browser_blocked' })).toEqual({
      device: 'browser_blocked',
    });
    expect(h.row()).toMatchObject({ deviceKind: 'browser_blocked', deviceSeenAt: at(0) });
    const client = { ...member, kind: 'client' } as unknown as Principal;
    await expect(h.service.reportDevice(me, client, { device: 'desktop' })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('review L1, L2: idle maximum and lost access', () => {
  it('the owner sets when someone counts as away (1 to 15); stored personal ones are ignored', async () => {
    // An older personal choice of 15 minutes is still stored; the workspace says 2.
    const open = row({
      idleThresholdMinutes: 15,
      sessionStartedAt: at(-600),
      lastActiveAt: at(-300),
      lastHeartbeatAt: at(-60),
    });
    const h = harness({ maxIdle: '2', row: open });
    expect((await h.service.get(me, member)).idleThresholdMinutes).toBe(2);
    // 5 minutes between two inputs is past the workspace's 2 (the stored 15 would join them): the
    // session ends at its last activity and a new one opens.
    await h.service.heartbeat(me, member, { idleSeconds: 0 });
    expect(h.entries[0]).toMatchObject({ startedAt: at(-600), endedAt: at(-300), minutes: 5 });
    await expect(
      h.service.setPolicy(me, owner, { policy: 'optional', maxIdleMinutes: 16 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.setPolicy(me, owner, { policy: 'optional', maxIdleMinutes: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await h.service.setPolicy(me, owner, { policy: 'optional', maxIdleMinutes: 3 })).toEqual(
      { policy: 'optional', maxIdleMinutes: 3 },
    );
    expect((await h.service.get(me, member)).idleThresholdMinutes).toBe(3);
  });

  it('a task the person lost access to receives nothing more', async () => {
    const open = row({
      workItemId: 'w1',
      projectId: 'p1',
      sessionStartedAt: at(-1800),
      lastActiveAt: at(-1200),
      lastHeartbeatAt: at(-1200),
    });
    const h = harness({ row: open, items: { w1: ITEM_W1 } });
    await h.service.heartbeat(me, member, { idleSeconds: 0 });
    expect(h.entries[0]).toMatchObject({ workItemId: null, projectId: null, minutes: 10 });
    expect(h.row()).toMatchObject({ workItemId: null, projectId: null });
  });
});
