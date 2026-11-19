import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { briefingSubjectKey, capabilitiesFor } from '@tmanage/domain';
import type { BriefingSubject, OpenSignal, Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { ApiError } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { HomeBriefingController } from './home-briefing.controller.js';
import { HOME_BRIEFING_SQL, HomeBriefingRepository } from './home-briefing.repository.js';
import { HomeBriefingService } from './home-briefing.service.js';

/**
 * 62-A1b (B11) — the Home briefing over fakes: the scope matrix (owner / lead / member / finance /
 * client and guest = 404), counts after the permission filter, "as of" from the last sweep.
 */

const ORG = '0199aa00-0000-7000-8000-00000000000a';
const SWEPT = new Date('2026-11-19T08:00:00.000Z');

type Role = Principal['role'];

function principal(role: Role, patch: Partial<Principal> = {}): Principal {
  return {
    userId: `u-${role}`,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: `m-${role}`,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
    ...patch,
  };
}

const contextOf = (role: Role) =>
  ({
    organizationId: ORG,
    userId: `u-${role}`,
    capabilities: capabilitiesFor(role),
  }) as unknown as TenantContext;

const signal = (
  id: string,
  rule: OpenSignal['rule'],
  subjectType: OpenSignal['subjectType'],
  projectId: string | null,
): OpenSignal => ({
  signalId: `sig-${id}`,
  rule,
  subjectType,
  subjectId: id,
  projectId,
  measure: 9,
  threshold: 7,
});

const SIGNALS: readonly OpenSignal[] = [
  signal('w1', 'stale_task', 'work_item', 'p1'),
  signal('w2', 'stale_task', 'work_item', 'p2'),
  signal('w-gone', 'stale_task', 'work_item', 'p1'),
  signal('i1', 'overdue_invoice', 'client_invoice', 'p1'),
  signal('m-team', 'overloaded_person', 'membership', null),
];

const SUBJECT: BriefingSubject = {
  title: 'A record',
  context: null,
  amount: null,
  category: null,
  deliverableId: null,
};

function build(sweptAt: Date | null = SWEPT, team: ReadonlySet<string> = new Set(['m-team'])) {
  const calls: string[] = [];
  const database = {
    read: async <T>(_c: TenantContext, work: (r: unknown) => Promise<T>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    lastSweep: async () => {
      calls.push('lastSweep');
      return sweptAt;
    },
    openSignals: async (_r: unknown, _c: unknown, since: Date) => {
      calls.push(`openSignals:${since.toISOString()}`);
      return SIGNALS;
    },
    team: async () => {
      calls.push('team');
      return team;
    },
    subjects: async (_r: unknown, _c: unknown, signals: readonly OpenSignal[]) => {
      calls.push(`subjects:${signals.map((s) => s.subjectId).join(',')}`);
      // `w-gone` was deleted: it does not resolve, so it is never counted.
      return new Map(
        signals
          .filter((s) => s.subjectId !== 'w-gone')
          .map((s) => [briefingSubjectKey(s.subjectType, s.subjectId), SUBJECT]),
      );
    },
  } as unknown as HomeBriefingRepository;
  return { service: new HomeBriefingService(database, repository), calls };
}

const counts = (view: { groups: readonly { group: string; count: number }[] }) =>
  Object.fromEntries(view.groups.map((g) => [g.group, g.count]));

describe('HomeBriefingService scope matrix', () => {
  it('owner: the company, money included, "as of" the last sweep', async () => {
    const { service, calls } = build();
    const view = await service.briefingOf(contextOf('owner'), principal('owner'));
    expect(view.audience).toBe('company');
    expect(view.asOf).toBe(SWEPT.toISOString());
    expect(counts(view)).toEqual({ money_to_collect: 1, people_overloaded: 1, stale_work: 2 });
    expect(calls).toContain(`openSignals:${SWEPT.toISOString()}`);
    expect(calls).not.toContain('team');
  });

  it('lead (manager on p1): their project and people only, no money without finance', async () => {
    const { service } = build();
    const lead = principal('member', { projectIds: ['p1'] });
    const context = {
      ...contextOf('member'),
      capabilities: [...capabilitiesFor('member'), 'project.manage'],
    } as TenantContext;
    const view = await service.briefingOf(context, lead);
    expect(view.audience).toBe('team');
    expect(counts(view)).toEqual({ people_overloaded: 1, stale_work: 1 });
  });

  it('manager with finance on p1: the money line of p1 too', async () => {
    const { service } = build();
    const manager = principal('manager', { projectIds: ['p1'] });
    const view = await service.briefingOf(contextOf('manager'), manager);
    expect(counts(view)).toEqual({ money_to_collect: 1, people_overloaded: 1, stale_work: 1 });
  });

  it('member who leads nothing and manages nobody: audience none, no signal read', async () => {
    const { service, calls } = build(SWEPT, new Set());
    const view = await service.briefingOf(
      contextOf('member'),
      principal('member', { projectIds: ['p1'] }),
    );
    expect(view).toEqual({ audience: 'none', asOf: null, groups: [] });
    expect(calls).toEqual(['team']);
  });

  it('member with a direct report: the overload of that person only', async () => {
    const { service } = build();
    const view = await service.briefingOf(
      contextOf('member'),
      principal('member', { projectIds: ['p1'] }),
    );
    expect(view.audience).toBe('team');
    expect(counts(view)).toEqual({ people_overloaded: 1 });
  });

  it('only visible signals are resolved', async () => {
    const { service, calls } = build();
    await service.briefingOf(
      {
        ...contextOf('member'),
        capabilities: [...capabilitiesFor('member'), 'project.manage'],
      } as TenantContext,
      principal('member', { projectIds: ['p1'] }),
    );
    expect(calls).toContain('subjects:w1,w-gone,m-team');
  });

  it('before the first sweep: no time and nothing to list', async () => {
    const { service, calls } = build(null);
    const view = await service.briefingOf(contextOf('owner'), principal('owner'));
    expect(view).toEqual({ audience: 'company', asOf: null, groups: [] });
    expect(calls).not.toContain(`openSignals:${SWEPT.toISOString()}`);
  });

  it.each([
    ['client', principal('client_admin', { kind: 'client', hasOrgWideScope: false })],
    ['guest', principal('guest', { hasOrgWideScope: false })],
  ])('%s: the calm 404, nothing read', async (_name, who) => {
    const { service, calls } = build();
    await expect(service.briefingOf(contextOf('guest'), who)).rejects.toMatchObject({
      status: 404,
    } satisfies Partial<ApiError>);
    expect(calls).toEqual([]);
  });

  it('the route ceiling is the one every principal holds, so the service answers with 404', () => {
    const handler = Object.getOwnPropertyDescriptor(HomeBriefingController.prototype, 'read');
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler?.value as object)).toBe(
      'approval.read',
    );
    for (const role of ['client_viewer', 'guest', 'member'] as const) {
      expect(capabilitiesFor(role)).toContain('approval.read');
    }
  });
});

describe('HomeBriefingRepository', () => {
  function runner(rows: Record<string, unknown>[][]) {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const fake = {
      execute: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return rows.shift() ?? [];
      },
    } as unknown as TenantQueryRunner;
    return { fake, calls };
  }
  const context = { organizationId: ORG } as TenantContext;

  it('open signals are the ones the last sweep saw, bound, capped, unknown rules dropped', async () => {
    const { fake, calls } = runner([
      [
        {
          id: 's1',
          rule_key: 'stale_task',
          subject_type: 'work_item',
          subject_id: 'w1',
          project_id: 'p1',
          measure: 9,
          threshold: 7,
        },
        {
          id: 's2',
          rule_key: 'retired_rule',
          subject_type: 'work_item',
          subject_id: 'w2',
          project_id: null,
          measure: 1,
          threshold: 1,
        },
      ],
    ]);
    const signals = await new HomeBriefingRepository().openSignals(fake, context, SWEPT);
    expect(signals.map((s) => s.signalId)).toEqual(['s1']);
    expect(calls[0]?.sql).toBe(HOME_BRIEFING_SQL.openSignals);
    expect(calls[0]?.params).toEqual([ORG, SWEPT, 2_000]);
  });

  it('subjects: one bound query per type, the organization first, an invoice reads its open amount', async () => {
    const { fake, calls } = runner([
      [{ id: 'w1', title: 'Footer redesign', project_name: 'Souq website' }],
      [
        {
          id: 'i1',
          number: 'INV-0038',
          total_minor: 500_000,
          paid_minor: 80_000,
          currency: 'USD',
          client_name: 'Cedar Foods',
        },
      ],
    ]);
    const subjects = await new HomeBriefingRepository().subjects(fake, context, [
      signal('w1', 'stale_task', 'work_item', 'p1'),
      signal('i1', 'overdue_invoice', 'client_invoice', 'p1'),
    ]);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.params[0]).toBe(ORG);
    expect(calls[0]?.sql).toMatch(/x\.deleted_at IS NULL/);
    expect(subjects.get('work_item:w1')).toMatchObject({
      title: 'Footer redesign',
      context: 'Souq website',
    });
    expect(subjects.get('client_invoice:i1')).toMatchObject({
      title: 'INV-0038',
      context: 'Cedar Foods',
      amount: { minor: 420_000, currency: 'USD' },
    });
    for (const call of calls) expect(call.sql).not.toMatch(/NOW\(|CURRENT_TIMESTAMP/i);
  });
});
