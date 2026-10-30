import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import {
  DurableRateLimiter,
  createMemoryBucketStore,
} from '../rate-limits/durable-rate-limiter.js';
import { roundMinutes } from './time-rounding.js';
import { parseManualSpan } from './time-rules.js';
import { TimeService } from './time.service.js';
import type { TimeServiceOptions } from './time.service.js';

/** 52-01 — the timer's rules over in-memory fakes and the real `authorize` (no database). */

const ORG = '01890000-0000-7000-8000-00000000000a';
const PROJECT = '01890000-0000-7000-8000-000000000101';
const ITEM = '01890000-0000-7000-8000-000000000201';
const MEMBER = '01890000-0000-7000-8000-000000000011';
const context = { organizationId: ORG, userId: 'u1', membershipId: MEMBER } as TenantContext;
const principal = (kind: Principal['kind'] = 'internal'): Principal => ({
  userId: 'u1',
  organizationId: ORG,
  kind,
  role: kind === 'internal' ? 'member' : 'client_admin',
  membershipId: MEMBER,
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
});
const item = { id: ITEM, organizationId: ORG, projectId: PROJECT, audience: 'internal' };
const itemRow = { ...item, state: 'todo', deletedAt: null, title: 'T' } as unknown as WorkItemRow;

function harness(presence = false, clock = { t: Date.parse('2026-10-30T09:00:00Z') }) {
  let timer: Record<string, unknown> | null = null;
  const logs: object[] = [];
  const audits: string[] = [];
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
      roundingMinutes: async () => 15,
      timePolicy: async () => ({ autostopHours: 12, presenceVisible: presence }),
    },
    timeLogs: {
      create: async (_r, _c, input) => (logs.push(input), { id: 'l1', ...input }) as never,
    },
    workItems: { findById: async () => itemRow },
    audit: { record: async (_r, _c, e) => (audits.push(e.action), {}) as never },
    limiter: new DurableRateLimiter({
      store: createMemoryBucketStore(),
      secret: 's',
      now: () => new Date(clock.t),
    }),
    now: () => new Date(clock.t),
  };
  return { service: new TimeService(options), logs, audits, clock };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; details?: readonly { message: string }[] }) =>
      e.details?.[0]?.message ?? e.code,
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

  it('throttles the heartbeat to two a minute', async () => {
    const h = harness();
    await h.service.start(context, principal(), {});
    const beats = [];
    for (let i = 0; i < 3; i += 1)
      beats.push(await code(h.service.heartbeat(context, principal())));
    expect(beats).toEqual(['ok', 'ok', 'rate_limited']);
  });
});
