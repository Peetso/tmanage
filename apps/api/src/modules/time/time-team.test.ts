import { describe, expect, it } from 'vitest';
import { principalHoldsCapability } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { TimeTeamService } from './time-team.service.js';
import type { TimeTeamServiceOptions } from './time-team.service.js';

/**
 * FIX-2026-11-10 — the team time view: who may see it, and that it only ever lists people of the
 * caller's own company. In-memory fakes keyed by organization, so a leak would show up as a row.
 */

const NOW = new Date('2026-11-10T12:00:00.000Z');
const M1 = '01890000-0000-7000-8000-0000000000a1';
const M2 = '01890000-0000-7000-8000-0000000000a2';
const OTHER = '01890000-0000-7000-8000-0000000000b1';
const ctx = { organizationId: 'o1', userId: 'u1', membershipId: M1 } as TenantContext;

const principal = (o: Record<string, unknown>) =>
  ({
    kind: 'internal',
    role: 'member',
    organizationId: 'o1',
    userId: 'u1',
    membershipId: M1,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
    ...o,
  }) as unknown as Principal;

/** Two companies' data; every fake filters by the context's organization, as the SQL does. */
const MEMBERS = [
  { org: 'o1', membershipId: M1, name: 'Amal' },
  { org: 'o1', membershipId: M2, name: 'Basel' },
  { org: 'o2', membershipId: OTHER, name: 'Stranger' },
];
const ENTRIES = [
  {
    org: 'o1',
    loggedBy: M2,
    spentOn: '2026-11-10',
    minutes: 45,
    projectId: null,
    workItemId: null,
  },
  {
    org: 'o2',
    loggedBy: OTHER,
    spentOn: '2026-11-10',
    minutes: 600,
    projectId: null,
    workItemId: null,
  },
];

function service() {
  const options = {
    now: () => NOW,
    database: { read: (_c: unknown, fn: (t: unknown) => unknown) => fn({}) },
    auto: {
      listForMembers: async (_r: unknown, c: TenantContext) =>
        c.organizationId === 'o1'
          ? [
              {
                organizationId: 'o1',
                membershipId: M2,
                enabled: true,
                idleThresholdMinutes: 5,
                workItemId: null,
                projectId: null,
                sessionStartedAt: new Date(NOW.getTime() - 600_000),
                lastActiveAt: new Date(NOW.getTime() - 30_000),
                lastHeartbeatAt: new Date(NOW.getTime() - 30_000),
              },
            ]
          : [],
      memberNames: async (_r: unknown, c: TenantContext, ids: readonly string[]) =>
        MEMBERS.filter((m) => m.org === c.organizationId && ids.includes(m.membershipId)).map(
          (m) => ({ membershipId: m.membershipId, displayName: m.name }),
        ),
    },
    sheets: {
      weekStart: async () => 1,
      internalMembers: async (_r: unknown, c: TenantContext) =>
        MEMBERS.filter((m) => m.org === c.organizationId).map((m) => ({
          membershipId: m.membershipId,
          userId: `u-${m.membershipId}`,
        })),
      entriesInPeriod: async (_r: unknown, c: TenantContext, ids: readonly string[]) =>
        ENTRIES.filter((e) => e.org === c.organizationId && ids.includes(e.loggedBy)).map((e) => ({
          id: `e-${e.loggedBy}`,
          startedAt: null,
          endedAt: null,
          source: 'manual',
          needsReview: false,
          ...e,
        })),
      titles: async () => new Map(),
    },
    timers: { listRunning: async () => [] },
    settings: { findByKey: async () => null },
  } as unknown as TimeTeamServiceOptions;
  return new TimeTeamService(options);
}

describe('team time view', () => {
  it('refuses a member without "View team time", at the guard and in the service', async () => {
    const plain = principal({});
    expect(principalHoldsCapability(plain, 'time.view_team')).toBe(false);
    await expect(service().list(ctx, plain, {})).rejects.toMatchObject({ status: 403 });
    await expect(service().day(ctx, plain, M2, '2026-11-10')).rejects.toMatchObject({
      status: 403,
    });
    // A deny override takes it from a workspace admin too.
    const denied = principal({
      role: 'workspace_admin',
      hasOrgWideScope: true,
      overrides: { allow: [], deny: ['time.view_team'] },
    });
    await expect(service().list(ctx, denied, {})).rejects.toMatchObject({ status: 403 });
  });

  it('allows owners and admins by role, and a member an admin authorized', async () => {
    for (const role of ['owner', 'org_admin', 'workspace_admin']) {
      const view = await service().list(ctx, principal({ role, hasOrgWideScope: true }), {});
      expect(view.people.map((p) => p.displayName)).toEqual(['Amal', 'Basel']);
    }
    const authorized = principal({ overrides: { allow: ['time.view_team'], deny: [] } });
    expect(principalHoldsCapability(authorized, 'time.view_team')).toBe(true);
    const view = await service().list(ctx, authorized, {});
    const basel = view.people.find((p) => p.membershipId === M2);
    expect(basel).toMatchObject({ live: 'tracking', todayMinutes: 55, weekMinutes: 55 });
    expect(view.totals.todayMinutes).toBe(55);
  });

  it('never returns another company’s people', async () => {
    const admin = principal({ role: 'org_admin', hasOrgWideScope: true });
    const view = await service().list(ctx, admin, {});
    expect(view.people.map((p) => p.membershipId)).not.toContain(OTHER);
    expect(view.totals.todayMinutes).toBe(55);
    await expect(service().list(ctx, admin, { membershipId: OTHER })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service().day(ctx, admin, OTHER, '2026-11-10')).rejects.toMatchObject({
      status: 404,
    });
    // A principal of another company cannot use this company's context.
    const foreign = principal({ role: 'owner', hasOrgWideScope: true, organizationId: 'o2' });
    await expect(service().list(ctx, foreign, {})).rejects.toMatchObject({ status: 403 });
  });

  it('a day: the person’s sessions with the open one, automatic or manual', async () => {
    const admin = principal({ role: 'owner', hasOrgWideScope: true });
    const day = await service().day(ctx, admin, M2, '2026-11-10');
    expect(day.sessions.map((s) => [s.source, s.open, s.minutes])).toEqual([
      ['automatic', true, 10],
      ['manual', false, 45],
    ]);
    expect(day.totalMinutes).toBe(55);
    await expect(
      service().list(ctx, admin, { from: '2026-11-10', to: '2026-01-01' }),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service().list(ctx, admin, { from: '2026-01-01', to: '2026-12-31' }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });
});
