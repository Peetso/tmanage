import { describe, expect, it } from 'vitest';
import { budgetAlertRecipients, decideBurnAlert, sweepBudgetBurn } from './budget-burn-sweeper.js';

const reading = {
  budgetType: 'hours',
  budgetMinutes: 600,
  budgetAmountMinor: null,
  alertThresholds: '70,85,95,100',
  lastAlertBp: 0,
  usedMinutes: 450,
  usedAmountMinor: 0,
};

describe('52-05 budget burn sweep', () => {
  it('raises the highest crossed threshold once, then nothing on the next reading', () => {
    const first = decideBurnAlert(reading);
    expect([first.raiseBp, first.lastAlertBp, first.burn.percentBp]).toEqual([7_000, 7_000, 7_500]);
    expect(decideBurnAlert({ ...reading, lastAlertBp: 7_000 }).raiseBp).toBeNull();
  });

  it('tells project.manage holders on the project or org-wide, once each', () => {
    expect(
      budgetAlertRecipients([
        { userId: 'a', role: 'manager', hasOrgWideScope: false, onProject: true },
        { userId: 'a', role: 'manager', hasOrgWideScope: false, onProject: true },
        { userId: 'b', role: 'manager', hasOrgWideScope: false, onProject: false },
        { userId: 'c', role: 'member', hasOrgWideScope: false, onProject: true },
        { userId: 'd', role: 'owner', hasOrgWideScope: true, onProject: false },
      ]),
    ).toEqual(['a', 'd']);
  });

  it('counts a failing budget and keeps sweeping the rest', async () => {
    const result = await sweepBudgetBurn({
      listBudgets: async () => [
        { organizationId: 'o', projectId: 'p1' },
        { organizationId: 'o', projectId: 'p2' },
      ],
      sweepBudget: async (b) => {
        if (b.projectId === 'p1') throw new Error('boom');
        return true;
      },
    });
    expect(result).toEqual({ budgets: 2, alerts: 1, failed: 1 });
  });
});
