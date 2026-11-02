import { describe, expect, it } from 'vitest';
import {
  capacityMinutes,
  expenseChargeMinor,
  marginBp,
  mergeFinanceFacts,
  utilisationBp,
  writeOffOf,
} from './profitability.js';

describe('52-14 profitability', () => {
  it('UNIT-52-20: margin after cost and marked-up expenses; null when nothing billed', () => {
    const expense = expenseChargeMinor({ amountBaseMinor: 1_000, markupBp: 1_500, billable: true });
    expect(expense).toBe(1_150);
    expect(expenseChargeMinor({ amountBaseMinor: 1_000, markupBp: 1_500, billable: false })).toBe(
      1_000,
    );
    expect(expenseChargeMinor({ amountBaseMinor: null, markupBp: 1_500, billable: true })).toBe(0);
    expect(marginBp(10_000, 6_000, expense)).toBe(2_850);
    expect(marginBp(1_000, 2_000, 0)).toBe(-10_000);
    expect(marginBp(0, 500, 0)).toBeNull();
  });

  it('UNIT-52-20: utilisation over capacity from weekly hours; write-off only on billing projects', () => {
    expect(capacityMinutes(40, '2026-11-01', '2026-11-07')).toBe(2_400);
    expect(capacityMinutes(40, '2026-11-07', '2026-11-01')).toBe(0);
    expect(utilisationBp(1_800, 2_400)).toBe(7_500);
    expect(utilisationBp(60, 0)).toBeNull();
    expect(writeOffOf({ minutes: 30, billable: false, projectBillableDefault: true })).toBe(30);
    expect(writeOffOf({ minutes: 30, billable: false, projectBillableDefault: false })).toBe(0);
    expect(writeOffOf({ minutes: 30, billable: true, projectBillableDefault: true })).toBe(0);
  });

  it('folds time and expenses into one row per day, project and member, client attached', () => {
    const grain = { day: '2026-11-02', projectId: 'p1', membershipId: 'm1' };
    const time = { ...grain, billableMinutes: 60, nonbillableMinutes: 30, writeoffMinutes: 30 };
    const facts = mergeFinanceFacts({
      time: [{ ...time, unpricedMinutes: 0, billedMinor: 5_000, costMinor: 2_000 }],
      expenses: [
        { ...grain, expenseMinor: 1_150 },
        { ...grain, projectId: '', expenseMinor: 100 },
      ],
      clientByProject: new Map([['p1', 'c1']]),
      currency: 'SAR',
    });
    expect(facts).toHaveLength(2);
    const byProject = new Map(facts.map((f) => [f.projectId, f]));
    expect(byProject.get('p1')).toMatchObject({ clientOrganizationId: 'c1', expenseMinor: 1_150 });
    expect(byProject.get('')).toMatchObject({ clientOrganizationId: null, expenseMinor: 100 });
  });
});
