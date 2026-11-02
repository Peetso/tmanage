import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ApiError } from '../../common/http/errors.js';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import {
  DELETE_FACTS_SQL,
  EXPENSE_FACTS_SQL,
  INSERT_FACTS_HEAD,
  INSERT_FACTS_TUPLE,
  TIME_FACTS_SQL,
  factInsertValues,
  profitabilitySql,
} from './finance-reports.repository.js';
import type { FinanceReportsRepository } from './finance-reports.repository.js';
import { FinanceReportsService } from './finance-reports.service.js';

/** 52-14 — the report service over in-memory fakes and the real `authorize`; DB cases not run. */

const ORG = '01890000-0000-7000-8000-00000000000a';
const context = { organizationId: ORG, userId: 'u1', membershipId: 'm1' } as TenantContext;
const as = (role: string): Principal =>
  ({
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  }) as Principal;

function harness(opts: { personReports?: string; lastComputedAt?: Date | null } = {}) {
  const audits: string[] = [];
  const repository = {
    profitability: async (_r: unknown, _c: unknown, q: { withCost: boolean }) => [
      {
        group_key: 'p1',
        billable_minutes: 120,
        nonbillable_minutes: 0,
        writeoff_minutes: 0,
        unpriced_minutes: 0,
        billed_minor: 10_000,
        expense_minor: 1_000,
        invoiced_minor: 0,
        ...(q.withCost ? { cost_minor: 4_000 } : {}),
      },
    ],
    names: async () => new Map([['p1', 'Site']]),
    baseCurrency: async () => 'SAR',
    lastComputedAt: async () => opts.lastComputedAt ?? null,
    setting: async () => opts.personReports,
    rebuildFacts: async () => 7,
  } as unknown as FinanceReportsRepository;
  const service = new FinanceReportsService({
    database: { read: (_c, f) => f({} as never), transaction: (_c, f) => f({} as never) },
    repository,
    budgets: { facts: async () => [] },
    audit: { record: async (_tx, _c, e) => (audits.push(e.action), {} as never) },
    now: () => new Date('2026-11-02T10:00:00Z'),
  });
  return { service, audits };
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: unknown) => (e as ApiError).status,
  );

describe('52-14 finance reports', () => {
  it('AUTH-52-14: a finance.view-only caller gets no cost or margin key; finance.manage does', async () => {
    const { service } = harness();
    const viewOnly = await service.profitability(context, as('manager'), { by: 'project' });
    expect(JSON.stringify(viewOnly)).not.toMatch(/cost|margin/i);
    expect(viewOnly.rows[0]).toMatchObject({ projectId: 'p1', unbilledMinor: 10_000 });
    const full = await service.profitability(context, as('owner'), { by: 'project' });
    expect(full.rows[0]).toMatchObject({ costMinor: 4_000, marginBp: 5_000 });
  });

  it('AUTH-52-14: person reports off refuses by=person to non-managers; range over 366 d is 422', async () => {
    const { service } = harness({ personReports: 'off' });
    expect(await status(service.profitability(context, as('manager'), { by: 'person' }))).toBe(403);
    expect(await status(service.utilisation(context, as('manager'), {}))).toBe(403);
    const range = { from: '2025-01-01', to: '2026-01-03' };
    expect(await status(service.profitability(context, as('owner'), range))).toBe(422);
  });

  it('rebuild needs finance.manage, is audited, and is held to once per 5 minutes', async () => {
    const fresh = harness();
    expect(await status(fresh.service.rebuild(context, as('manager')))).toBe(403);
    expect(await fresh.service.rebuild(context, as('owner'))).toMatchObject({ rows: 7 });
    expect(fresh.audits).toEqual(['finance.facts_rebuilt']);
    const recent = harness({ lastComputedAt: new Date('2026-11-02T09:57:00Z') });
    expect(await status(recent.service.rebuild(context, as('owner')))).toBe(429);
  });

  it('every rebuild and report statement passes the tenant guard for the acting org', () => {
    const insert = INSERT_FACTS_HEAD + [INSERT_FACTS_TUPLE, INSERT_FACTS_TUPLE].join(', ');
    const fact = {
      day: '2026-11-01',
      projectId: '',
      membershipId: '',
      clientOrganizationId: null,
      billableMinutes: 0,
      nonbillableMinutes: 0,
      writeoffMinutes: 0,
      unpricedMinutes: 0,
      billedMinor: 0,
      costMinor: 0,
      expenseMinor: 0,
      invoicedMinor: 0,
      currency: null,
    };
    const values = [fact, fact].flatMap((f) => factInsertValues(ORG, f, new Date()));
    const range = [ORG, '2026-08-05', '2026-11-02'];
    const cases: [string, readonly unknown[]][] = [
      [TIME_FACTS_SQL, range],
      [EXPENSE_FACTS_SQL, range],
      [DELETE_FACTS_SQL, range],
      [insert, values],
      [profitabilitySql('client', true, 10), range],
    ];
    for (const [sql, params] of cases) {
      expect(analyzeStatement(sql, params, ORG).violations).toEqual([]);
    }
  });
});
