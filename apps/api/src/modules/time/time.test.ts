import { describe, expect, it } from 'vitest';
import { roundMinutes } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import {
  DurableRateLimiter,
  createMemoryBucketStore,
} from '../rate-limits/durable-rate-limiter.js';
import { parseManualSpan } from './time-rules.js';
import { TimeService } from './time.service.js';
import type { TimeServiceOptions } from './time.service.js';

/** 52-01 — the timer's rules over in-memory fakes and the real `authorize` (no database). */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const ITEM = '01890000-0000-7000-8000-000000000201';
const MEMBER = '01890000-0000-7000-8000-000000000011';
const context = { organizationId: ORG, userId: 'u1', membershipId: MEMBER } as TenantContext;
const principal = (
  kind: Principal['kind'] = 'internal',
  role: Principal['role'] = kind === 'internal' ? 'member' : 'client_admin',
): Principal => ({
  userId: 'u1',
  organizationId: ORG,
  kind,
  role,
  membershipId: MEMBER,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
});
const item = { id: ITEM, organizationId: ORG, projectId: PROJECT, audience: 'internal' };
const itemRow = { ...item, state: 'todo', deletedAt: null, title: 'T' } as unknown as WorkItemRow;

interface Setup {
  /** The stored `org_finance_profiles.rounding_minutes`; `null` = no finance profile yet. */
  readonly rounding?: number | null;
  /** The stored `default_timezone`; absent = none written. */
  readonly zone?: string;
}

function harness(
  presence = false,
  clock = { t: Date.parse('2026-10-30T09:00:00Z') },
  setup: Setup = {},
) {
  let timer: Record<string, unknown> | null = null;
  const logs: object[] = [];
  const audits: string[] = [];
  const auditRows: { action: string; actorUserId?: string | null; metadata?: unknown }[] = [];
  const store = { rounding: setup.rounding === undefined ? 15 : setup.rounding };
  const profileWrites: { kind: 'insert' | 'update'; roundingMinutes: number }[] = [];
  const options: TimeServiceOptions = {
    database: {
      read: (_c, f) => f({} as never),
      transaction: (_c, f) => f({} as never),
    } as TimeServiceOptions['database'],
    repository: {
      findTimer: async () => timer as never,
      insertTimer: async (_r, _c, input) =>
        (timer = { id: `t${logs.length}`, ...input, lastHeartbeatAt: input.startedAt }) as never,
      deleteTimer: async () => (timer ? ((timer = null), 1) : 0),
      touchHeartbeat: async () => undefined,
      listRunning: async () => (timer ? [timer] : []) as never,
      projectExists: async () => true,
      workItemExists: async () => true,
      roundingMinutes: async () => store.rounding,
      timePolicy: async () => ({ autostopHours: 12, presenceVisible: presence }),
    },
    timeLogs: {
      create: async (_r, _c, input) => (logs.push(input), { id: 'l1', ...input }) as never,
    },
    workItems: { findById: async () => itemRow },
    settings: {
      findByKey: async (_r, _c, key) =>
        key === 'default_timezone' && setup.zone !== undefined
          ? ({ settingValue: setup.zone } as never)
          : undefined,
    },
    finance: {
      organization: async () => ({ name: 'Acme', defaultLocale: 'en-GB', timezone: 'UTC' }),
      profile: async () =>
        (store.rounding === null ? null : { roundingMinutes: store.rounding }) as never,
      insertProfile: async (_r, _o, values) => {
        profileWrites.push({ kind: 'insert', roundingMinutes: values.roundingMinutes });
        store.rounding = values.roundingMinutes;
      },
      updateRoundingMinutes: async (_r, _o, minutes) => {
        profileWrites.push({ kind: 'update', roundingMinutes: minutes });
        store.rounding = minutes;
      },
    },
    audit: {
      record: async (_r, _c, e) => (audits.push(e.action), auditRows.push(e), {}) as never,
    },
    limiter: new DurableRateLimiter({
      store: createMemoryBucketStore(),
      secret: 's',
      now: () => new Date(clock.t),
    }),
    now: () => new Date(clock.t),
  };
  return { service: new TimeService(options), logs, audits, auditRows, profileWrites, clock };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; details?: readonly { message: string }[] }) =>
      e.code === 'validation_failed' ? e.code : (e.details?.[0]?.message ?? e.code),
  );

describe('52-01 timer', () => {
  it('rounds up to the org increment', () => {
    expect([1, 16].map((m) => roundMinutes(m, 15))).toEqual([15, 30]);
    expect([1, 5, 6, 10, 15, 30].map((step) => roundMinutes(7, step))).toEqual([
      7, 10, 12, 10, 15, 30,
    ]);
    expect(roundMinutes(7, 0)).toBe(7);
  });

  it('keeps one timer per member; force files the first one', async () => {
    const h = harness();
    await h.service.start(context, principal(), { workItemId: ITEM });
    expect(await code(h.service.start(context, principal(), {}))).toBe('timer_running');
    await h.service.start(context, principal(), { projectId: PROJECT, force: true });
    expect(h.logs).toHaveLength(1);
    expect(h.audits).toEqual(['time_timer.started', 'time_log.created', 'time_timer.started']);
  });

  it('stop writes exactly one entry with start, end and source', async () => {
    const h = harness();
    await h.service.start(context, principal(), { workItemId: ITEM });
    h.clock.t += 16 * 60_000;
    const entry = await h.service.stop(context, principal(), {});
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ workItemId: ITEM, source: 'timer', minutes: 30 });
    expect(entry.endedAt).toBe('2026-10-30T09:16:00.000Z');
    expect(await code(h.service.stop(context, principal(), {}))).toBe('timer_not_running');
  });

  it('refuses a manual span outside the last 31 days', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(() => parseManualSpan('2026-09-28T09:00:00Z', '2026-09-28T10:00:00Z', now)).toThrow();
    expect(parseManualSpan('2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z', now)).not.toBeNull();
  });

  it('refuses a client principal, and presence is 404 while off', async () => {
    const h = harness();
    expect(await code(h.service.start(context, principal('client'), {}))).toBe('forbidden');
    expect(await code(h.service.active(context, principal(), undefined))).toBe('not_found');
    const on = harness(true);
    await on.service.start(context, principal(), { workItemId: ITEM });
    const { timers } = await on.service.active(context, principal(), undefined);
    expect(timers[0]).toMatchObject({ projectId: PROJECT, workItemTitle: 'T' });
  });

  it('saves the configured step, and the timer read announces it', async () => {
    const h = harness(false, undefined, { rounding: 5 });
    await h.service.start(context, principal(), { workItemId: ITEM });
    h.clock.t += 11_000;
    expect((await h.service.get(context, principal())).roundingMinutes).toBe(5);
    await h.service.stop(context, principal(), {});
    expect(h.logs[0]).toMatchObject({ minutes: 5 });
  });

  it('"no rounding" saves the exact whole minutes', async () => {
    const h = harness(false, undefined, { rounding: 1 });
    await h.service.start(context, principal(), { workItemId: ITEM });
    h.clock.t += 7 * 60_000 + 11_000;
    await h.service.stop(context, principal(), {});
    expect(h.logs[0]).toMatchObject({ minutes: 8 });
  });

  it('files the entry on the company-zone day the timer started', async () => {
    // 22:30 UTC on 30 October is 00:30 on 31 October in Cairo (UTC+2 that night).
    const clock = { t: Date.parse('2026-10-30T22:30:00Z') };
    const cairo = harness(false, clock, { zone: 'Africa/Cairo' });
    await cairo.service.start(context, principal(), { workItemId: ITEM });
    clock.t += 20 * 60_000;
    expect((await cairo.service.stop(context, principal(), {})).spentOn).toBe('2026-10-31');

    const utc = harness(false, { t: Date.parse('2026-10-30T22:30:00Z') });
    await utc.service.start(context, principal(), { workItemId: ITEM });
    expect((await utc.service.stop(context, principal(), {})).spentOn).toBe('2026-10-30');
  });

  it('lets only the owner change the step, audited with the actor', async () => {
    const h = harness(false, undefined, { rounding: null });
    expect(await code(h.service.setRounding(context, principal(), { roundingMinutes: 5 }))).toBe(
      'forbidden',
    );
    expect(
      await code(
        h.service.setRounding(context, principal('internal', 'org_admin'), { roundingMinutes: 5 }),
      ),
    ).toBe('forbidden');
    const owner = principal('internal', 'owner');
    expect(await code(h.service.setRounding(context, owner, { roundingMinutes: 7 }))).toBe(
      'validation_failed',
    );
    expect(await code(h.service.setRounding(context, owner, { roundingMinutes: '5' }))).toBe(
      'validation_failed',
    );
    expect(h.profileWrites).toEqual([]);

    expect(await h.service.setRounding(context, owner, { roundingMinutes: 1 })).toEqual({
      roundingMinutes: 1,
    });
    await h.service.setRounding(context, owner, { roundingMinutes: 30 });
    expect(h.profileWrites).toEqual([
      { kind: 'insert', roundingMinutes: 1 },
      { kind: 'update', roundingMinutes: 30 },
    ]);
    expect(h.auditRows).toEqual([
      expect.objectContaining({
        action: 'organization.time_rounding_changed',
        actorUserId: 'u1',
        metadata: { previous: 15, value: 1 },
      }),
      expect.objectContaining({ metadata: { previous: 1, value: 30 } }),
    ]);
    expect((await h.service.get(context, principal())).roundingMinutes).toBe(30);
  });

  it('throttles the heartbeat to two a minute', async () => {
    const h = harness();
    await h.service.start(context, principal(), {});
    const beats = [];
    for (let i = 0; i < 3; i += 1)
      beats.push(await code(h.service.heartbeat(context, principal())));
    expect(beats).toEqual(['ok', 'ok', 'rate_limited']);
  });
});
