import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ExpenseRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { nextExpenseState, toBaseMinor, validateExpense } from './expenses-rules.js';
import { ExpensesService, expensesCsv } from './expenses.service.js';

/** 52-07 — rules and service over in-memory fakes and the real `authorize`. INT-52-16 is DB. */

const ORG = '01890000-0000-7000-8000-00000000000a';
const context = { organizationId: ORG, userId: 'u1', membershipId: 'm1' } as TenantContext;
const owner = {
  userId: 'u1',
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [],
  hasOrgWideScope: true,
} as unknown as Principal;
const row = (over: Partial<ExpenseRow>): ExpenseRow =>
  ({
    id: 'e1',
    organizationId: ORG,
    projectId: null,
    membershipId: 'm1',
    spentOn: '2026-10-01',
    amountMinor: 1000,
    currency: 'USD',
    state: 'draft',
    lockedAt: null,
    note: 'taxi',
    version: 1,
    ...over,
  }) as ExpenseRow;

function service(found: ExpenseRow) {
  const fn = (_c: unknown, f: (r: unknown) => unknown) => f({});
  return new ExpensesService({
    database: { transaction: fn, read: fn } as never,
    repository: { find: async () => found } as never,
    finance: {
      profile: async () => ({ baseCurrency: 'SAR' }),
      exchangeRates: async () => [],
    } as never,
    rates: {} as never,
    notifications: {} as never,
    audit: { record: async () => ({}) } as never,
  });
}

describe('UNIT-52-10 — expense state machine', () => {
  it('allows only the planned transitions', () => {
    expect(nextExpenseState('draft', 'submit')).toBe('submitted');
    expect(nextExpenseState('rejected', 'submit')).toBe('submitted');
    expect(nextExpenseState('submitted', 'approve')).toBe('approved');
    expect(nextExpenseState('submitted', 'reject')).toBe('rejected');
    expect(nextExpenseState('approved', 'edit')).toBeNull();
    expect(nextExpenseState('submitted', 'delete')).toBeNull();
    expect(nextExpenseState('invoiced', 'reject')).toBeNull();
    expect(nextExpenseState('locked', 'edit')).toBeNull();
  });
});

describe('52-07 money and permission rules', () => {
  const body = { spentOn: '2026-10-01', category: 'Ads', amountMinor: 100, currency: 'SAR' };

  it('caps markup at 100 % unless the caller holds finance.manage', () => {
    expect(() => validateExpense({ ...body, markupBp: 15_000 }, false)).toThrow();
    expect(validateExpense({ ...body, markupBp: 15_000 }, true).markupBp).toBe(15_000);
  });

  it('converts across minor digits, half up', () => {
    expect(toBaseMinor(1000, 'USD', 'SAR', '3.75')).toBe(3750);
    expect(toBaseMinor(1001, 'KWD', 'SAR', '12.2')).toBe(1221);
  });

  it('refuses submit with 422 fx_rate_missing when no rate exists', async () => {
    await expect(service(row({})).submit(context, owner, 'e1')).rejects.toMatchObject({
      status: 422,
      details: [{ field: 'currency', message: 'fx_rate_missing' }],
    });
  });

  it('AUTH-52-08 / B20 — never approves or rejects one’s own expense, timesheet error shape', async () => {
    const own = { status: 403, code: 'forbidden', auditCode: 'cannot_approve_own' };
    const details = [{ field: 'expenseId', message: 'cannot_approve_own' }];
    await expect(
      service(row({ state: 'submitted' })).approve(context, owner, 'e1', {}),
    ).rejects.toMatchObject({ ...own, details });
    await expect(
      service(row({ state: 'submitted' })).reject(context, owner, 'e1', { note: 'not mine' }),
    ).rejects.toMatchObject(own);
  });

  it('exports a note only on the exporter’s own rows', () => {
    const csv = expensesCsv([row({}), row({ id: 'e2', membershipId: 'm2' })], 'm1');
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]?.split(',').at(-1)).toBe('note');
    expect(lines[1]?.endsWith(',taxi')).toBe(true);
    expect(lines[2]?.endsWith(',')).toBe(true);
  });
});
