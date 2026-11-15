import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { SupportRepository, SupportThreadRecord } from './support.repository.js';
import { addBusinessMinutes, SUPPORT_HOURS, slaClock, slaTargets } from './support-sla.js';
import type { SlaState } from './support-sla.js';
import { slaAfter, SupportService } from './support.service.js';

const RIYADH = 'Asia/Riyadh';
const at = (iso: string) => new Date(iso);
const base: SlaState = {
  createdAt: at('2026-11-15T06:00:00Z'), // Sunday 09:00 Riyadh
  status: 'open',
  closedAt: null,
  timezone: RIYADH,
  firstResponseMinutes: 240,
  resolutionMinutes: 540,
  firstResponseAt: null,
  pausedAt: null,
  pausedMinutes: 0,
};

describe('57-10 support SLA clock', () => {
  it('counts business hours only and skips holidays (SUP-04)', () => {
    const thu = at('2026-11-12T14:30:00Z'); // Thursday 17:30 Riyadh
    expect(addBusinessMinutes(thu, 240, RIYADH).toISOString()).toBe('2026-11-15T09:30:00.000Z');
    const holiday = { ...SUPPORT_HOURS, holidays: new Set(['2026-11-15']) };
    expect(addBusinessMinutes(thu, 240, RIYADH, holiday).toISOString()).toBe(
      '2026-11-16T09:30:00.000Z',
    );
  });

  it('targets come from the plan and priority captured at opening (SUP-03)', () => {
    expect(slaTargets('business', 'urgent')).toEqual({
      firstResponseMinutes: 120,
      resolutionMinutes: 540,
    });
    expect(slaTargets('free', 'normal').firstResponseMinutes).toBe(1080);
  });

  it('the resolution clock pauses while waiting on the customer and resumes after', () => {
    const waiting = { ...base, status: 'waiting' as const, pausedAt: at('2026-11-15T07:00:00Z') };
    const paused = slaClock(waiting, at('2026-11-15T09:00:00Z'));
    expect(paused?.paused).toBe(true);
    expect(paused?.resolution).toMatchObject({ elapsedMinutes: 60, dueAt: null });
    const resumed = slaClock({ ...base, pausedMinutes: 120 }, at('2026-11-15T10:00:00Z'));
    expect(resumed?.resolution).toMatchObject({ elapsedMinutes: 120, breached: false });
    expect(resumed?.resolution.dueAt).toBe('2026-11-16T08:00:00.000Z');
  });

  it('breach is computed from business minutes; a reply in time is not a breach', () => {
    expect(slaClock(base, at('2026-11-15T11:01:00Z'))?.firstResponse.breached).toBe(true);
    const replied = { ...base, firstResponseAt: at('2026-11-15T09:00:00Z') };
    expect(slaClock(replied, at('2026-11-16T12:00:00Z'))?.firstResponse.breached).toBe(false);
    expect(
      slaClock({ ...base, firstResponseMinutes: null }, at('2026-11-20T00:00:00Z')),
    ).toBeNull();
  });

  it('only a platform reply sets first_response_at (SUP-05)', () => {
    const thread = {
      createdAt: base.createdAt,
      status: 'open',
      closedAt: null,
      slaTimezone: RIYADH,
      slaFirstResponseMinutes: 240,
      slaResolutionMinutes: 540,
      slaPausedAt: null,
      slaPausedMinutes: 0,
      slaBreached: false,
    } as never as SupportThreadRecord;
    const now = at('2026-11-15T07:00:00Z');
    expect(slaAfter({ ...thread, firstResponseAt: null }, 'open', now).firstResponseAt).toBeNull();
    expect(
      slaAfter({ ...thread, firstResponseAt: null }, 'waiting', now, true).firstResponseAt,
    ).toEqual(now);
  });

  it("another organization's thread id answers 404 under the caller's own tenant", async () => {
    const run = async (_c: unknown, work: (db: unknown) => unknown) => work({});
    const repository = {
      find: async (_db: unknown, c: TenantContext) => (c.organizationId === 'org-b' ? {} : null),
    };
    const service = new SupportService({
      database: { read: run, transaction: run } as never,
      repository: repository as unknown as SupportRepository,
    } as never);
    const context = {
      organizationId: 'org-a',
      userId: 'u',
      principalKind: 'internal',
      capabilities: [],
    };
    const outcome = await service
      .get(context as unknown as TenantContext, '0199aa00-0000-7000-8000-0000000000e1')
      .catch((e: { status: number }) => e.status);
    expect(outcome).toBe(404);
  });
});
