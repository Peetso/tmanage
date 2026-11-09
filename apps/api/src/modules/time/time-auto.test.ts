import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TimeAutoTrackingRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { applyHeartbeat, automaticMinutes, freeSpans, settle } from './time-auto-rules.js';
import type { OpenSession } from './time-auto-rules.js';
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
    createdAt: T0,
    updatedAt: T0,
    ...o,
  };
}

function harness(
  o: { row?: TimeAutoTrackingRow; policy?: string; busy?: unknown[]; nowS?: number } = {},
) {
  let current = o.row ?? row();
  const entries: Record<string, unknown>[] = [];
  const limiterCalls: string[] = [];
  const options = {
    now: () => at(o.nowS ?? 0),
    database: {
      transaction: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
      read: (_c: unknown, fn: (t: unknown) => unknown) => fn({}),
    },
    repository: {
      find: async () => current,
      ensureOwn: async () => current,
      update: async (
        _r: unknown,
        _c: unknown,
        _id: string,
        patch: Partial<TimeAutoTrackingRow>,
      ) => {
        current = { ...current, ...patch };
      },
      timedEntriesOverlapping: async () => o.busy ?? [],
    },
    timers: {
      findTimer: async () => null,
      projectExists: async () => true,
      workItemExists: async () => true,
    },
    settings: {
      findByKey: async () => (o.policy ? { settingValue: o.policy } : null),
      upsert: async () => undefined,
      resolveOrganization: async () => ({ id: 'o1' }),
    },
    timeLogs: {
      create: async (_r: unknown, _c: unknown, input: Record<string, unknown>) => {
        entries.push(input);
        return { id: `e${entries.length}` };
      },
    },
    workItems: { findById: async () => null },
    audit: { record: async () => undefined },
    limiter: {
      check: async (_p: unknown, subject: { link: string }) => {
        limiterCalls.push(subject.link);
        return { admitted: limiterCalls.length <= 12 };
      },
    },
  } as unknown as TimeAutoServiceOptions;
  return { service: new TimeAutoService(options), entries, limiterCalls, row: () => current };
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
    const { service, entries, row: after } = harness({ row: open });
    await service.heartbeat(me, member, { idleSeconds: 0 });
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
    });
    const client = { ...member, kind: 'client' } as unknown as Principal;
    await expect(service.heartbeat(me, client, { idleSeconds: 0 })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('settings: idle threshold must be 1 to 30 whole minutes', async () => {
    const { service, row: after } = harness();
    await expect(
      service.updateSettings(me, member, { enabled: true, idleThresholdMinutes: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.updateSettings(me, member, { enabled: true, idleThresholdMinutes: 31 }),
    ).rejects.toMatchObject({ status: 400 });
    const view = await service.updateSettings(me, member, {
      enabled: true,
      idleThresholdMinutes: 10,
    });
    expect(view.idleThresholdMinutes).toBe(10);
    expect(after().idleThresholdMinutes).toBe(10);
    expect(view.visibleTo).toBe('admins_and_authorized');
  });
});
