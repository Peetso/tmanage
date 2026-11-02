import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  nextRetainerState,
  periodBounds,
  periodContaining,
  rolloverIn,
} from './retainers-rules.js';
import { RetainersService } from './retainers.service.js';
import type { RetainersRepository } from './retainers.repository.js';

/** UNIT-52-09 period maths and rollover; the state machine; a `work.read` viewer sees no money. */

describe('UNIT-52-09 retainer periods and rollover', () => {
  it('anchors on the 31st and clamps to the month, and steps quarters', () => {
    expect(periodBounds('2026-01-31', 'monthly', 0)).toEqual({
      periodStart: '2026-01-31',
      periodEnd: '2026-02-27',
    });
    expect(periodBounds('2026-01-31', 'monthly', 1).periodStart).toBe('2026-02-28');
    expect(periodBounds('2026-01-31', 'monthly', 2).periodStart).toBe('2026-03-31');
    expect(periodBounds('2026-11-15', 'quarterly', 1)).toEqual({
      periodStart: '2027-02-15',
      periodEnd: '2027-05-14',
    });
    expect(periodContaining('2026-01-31', 'monthly', '2026-03-30')?.index).toBe(1);
    expect(periodContaining('2026-01-31', 'monthly', '2026-01-30')).toBeNull();
  });

  it('rolls none / cap / unlimited and never negative', () => {
    expect(rolloverIn(900, 'none', null)).toBe(0);
    expect(rolloverIn(900, 'cap', 600)).toBe(600);
    expect(rolloverIn(900, 'unlimited', null)).toBe(900);
    expect(rolloverIn(-120, 'unlimited', null)).toBe(0);
  });

  it('pauses, resumes and ends; ended is final', () => {
    expect(nextRetainerState('active', 'pause')).toBe('paused');
    expect(nextRetainerState('paused', 'resume')).toBe('active');
    expect(nextRetainerState('active', 'resume')).toBeNull();
    expect(nextRetainerState('paused', 'end')).toBe('ended');
    expect(nextRetainerState('ended', 'resume')).toBeNull();
  });
});

describe('retainer.view without finance.view', () => {
  it('a member on a covered project reads hours but no amount or currency', async () => {
    const ORG = '00000000-0000-7000-8000-000000000001';
    const member = {
      userId: 'u1',
      organizationId: ORG,
      kind: 'internal',
      role: 'member',
      membershipId: 'm1',
      membershipStatus: 'active',
      clientOrganizationId: null,
      projectIds: ['p1'],
      hasOrgWideScope: false,
    } as unknown as Principal;
    const at = new Date('2026-10-01T00:00:00Z');
    const repository = {
      find: async () => ({
        id: 'r1',
        organizationId: ORG,
        clientOrganizationId: 'c1',
        name: 'Social media',
        period: 'monthly',
        hoursPerPeriod: 40,
        amountPerPeriodMinor: 800_000,
        currency: 'SAR',
        rollover: 'none',
        rolloverCapMinutes: null,
        billingTiming: 'advance',
        startsOn: '2026-10-01',
        endsOn: null,
        state: 'active',
        clientVisible: true,
        rateCardId: null,
        createdBy: 'u0',
        createdAt: at,
        updatedAt: at,
      }),
      projectsOf: async () => new Map([['r1', ['p1']]]),
    } as unknown as RetainersRepository;
    const service = new RetainersService({
      database: { read: async (_c: unknown, work: (r: unknown) => unknown) => work({}) } as never,
      repository,
      finance: {} as never,
      audit: {} as never,
    });
    const view = await service.get({ organizationId: ORG } as TenantContext, member, 'r1');
    expect(view.hoursPerPeriod).toBe(40);
    expect(Object.keys(view).join(',')).not.toMatch(/amount|currency|rate|minor/i);
  });
});
