import { describe, expect, it } from 'vitest';
import {
  capacityMinutesUntil,
  evaluateDeadlineAtRisk,
  queuedMinutesByItem,
} from './deadline-at-risk.js';
import { evaluateOverloadedPerson, plannedMinutesThisWeek } from './overloaded-person.js';
import { evaluateOverdueInvoice } from './overdue-invoice.js';
import { evaluateProjectOverBudget } from './project-over-budget.js';
import { evaluateStaleTask } from './stale-task.js';
import { evaluateUnusualExpense, median } from './unusual-expense.js';
import { evaluateApprovalWaitingOnClient } from './approval-waiting-on-client.js';
import { evaluateApprovedTimeNotInvoiced } from './approved-time-not-invoiced.js';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const DAY = 86_400_000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY);

describe('deadline at risk', () => {
  const base = {
    workItemId: 'w1',
    projectId: 'p1',
    state: 'in_progress',
    dueAt: daysFromNow(3),
    remainingMinutes: 14 * 60,
    queuedMinutes: 14 * 60,
    capacityMinutesUntilDue: 6 * 60,
  };

  it('fires when the work left does not fit before the due date', () => {
    expect(evaluateDeadlineAtRisk(base, 5, NOW)).toMatchObject({
      rule: 'deadline_at_risk',
      subjectId: 'w1',
      projectId: 'p1',
      measure: 3,
      threshold: 5,
    });
  });

  it('does not fire when the work fits, or the item is done', () => {
    expect(
      evaluateDeadlineAtRisk({ ...base, capacityMinutesUntilDue: 20 * 60 }, 5, NOW),
    ).toBeNull();
    expect(evaluateDeadlineAtRisk({ ...base, state: 'done' }, 5, NOW)).toBeNull();
  });

  it('threshold edge: due exactly N days ahead counts, a minute later does not', () => {
    expect(evaluateDeadlineAtRisk({ ...base, dueAt: daysFromNow(5) }, 5, NOW)).not.toBeNull();
    const later = new Date(daysFromNow(5).getTime() + 60_000);
    expect(evaluateDeadlineAtRisk({ ...base, dueAt: later }, 5, NOW)).toBeNull();
  });

  it('a late open item fires without an estimate; an unassigned item with work left fires', () => {
    const late = { ...base, dueAt: daysFromNow(-1), remainingMinutes: 0, queuedMinutes: 0 };
    expect(evaluateDeadlineAtRisk(late, 5, NOW)?.measure).toBe(-1);
    expect(
      evaluateDeadlineAtRisk({ ...base, capacityMinutesUntilDue: null }, 5, NOW),
    ).not.toBeNull();
    const noEstimate = {
      ...base,
      remainingMinutes: 0,
      queuedMinutes: 0,
      capacityMinutesUntilDue: 0,
    };
    expect(evaluateDeadlineAtRisk(noEstimate, 5, NOW)).toBeNull();
  });

  it('queues a person’s work in due order and spreads weekly capacity over the time left', () => {
    const queued = queuedMinutesByItem([
      { workItemId: 'b', dueAt: daysFromNow(4), remainingMinutes: 120 },
      { workItemId: 'a', dueAt: daysFromNow(2), remainingMinutes: 60 },
      { workItemId: 'c', dueAt: daysFromNow(4), remainingMinutes: -5 },
    ]);
    expect([...queued]).toEqual([
      ['a', 60],
      ['b', 180],
      ['c', 180],
    ]);
    expect(capacityMinutesUntil(40 * 60, NOW, daysFromNow(7))).toBe(2400);
    expect(capacityMinutesUntil(40 * 60, NOW, daysFromNow(-1))).toBe(0);
  });
});

describe('overloaded person', () => {
  const facts = { membershipId: 'm1', weeklyCapacityMinutes: 2400, plannedMinutes: 2640 };

  it('fires at the threshold share of capacity (edge 110 %) and not below', () => {
    expect(evaluateOverloadedPerson(facts, 110)).toMatchObject({ subjectId: 'm1', measure: 110 });
    expect(evaluateOverloadedPerson({ ...facts, plannedMinutes: 2639 }, 110)).toBeNull();
  });

  it('a person without capacity is never measured', () => {
    expect(evaluateOverloadedPerson({ ...facts, weeklyCapacityMinutes: 0 }, 110)).toBeNull();
  });

  it('plans only open items due within the week or late', () => {
    const planned = plannedMinutesThisWeek(
      [
        { state: 'in_progress', dueAt: daysFromNow(2), remainingMinutes: 100 },
        { state: 'backlog', dueAt: daysFromNow(-3), remainingMinutes: 50 },
        { state: 'done', dueAt: daysFromNow(1), remainingMinutes: 999 },
        { state: 'ready', dueAt: daysFromNow(8), remainingMinutes: 999 },
        { state: 'ready', dueAt: null, remainingMinutes: 999 },
      ],
      NOW,
    );
    expect(planned).toBe(150);
  });
});

describe('overdue invoice', () => {
  const facts = {
    invoiceId: 'i1',
    projectId: null,
    state: 'sent',
    dueDate: '2026-11-12',
    totalMinor: 420_000,
    paidMinor: 0,
  };

  it('fires at N days overdue (edge) and not a day earlier', () => {
    expect(evaluateOverdueInvoice(facts, 7, NOW)).toMatchObject({ subjectId: 'i1', measure: 7 });
    expect(evaluateOverdueInvoice({ ...facts, dueDate: '2026-11-13' }, 7, NOW)).toBeNull();
  });

  it('does not fire when paid, settled, a draft or without a due date', () => {
    expect(evaluateOverdueInvoice({ ...facts, paidMinor: 420_000 }, 7, NOW)).toBeNull();
    expect(evaluateOverdueInvoice({ ...facts, state: 'paid' }, 7, NOW)).toBeNull();
    expect(evaluateOverdueInvoice({ ...facts, state: 'draft' }, 7, NOW)).toBeNull();
    expect(evaluateOverdueInvoice({ ...facts, dueDate: null }, 7, NOW)).toBeNull();
  });

  it('a partly paid invoice with money left still fires', () => {
    expect(
      evaluateOverdueInvoice({ ...facts, state: 'partially_paid', paidMinor: 1 }, 7, NOW),
    ).not.toBeNull();
  });
});

describe('project over budget', () => {
  const facts = {
    projectId: 'p1',
    budgetType: 'money',
    budgetMinutes: null,
    budgetAmountMinor: 100_000,
    usedMinutes: 0,
    usedAmountMinor: 112_000,
  };

  it('fires at the burn share, exactly at the edge, and not below', () => {
    expect(evaluateProjectOverBudget(facts, 100)).toMatchObject({ subjectId: 'p1', measure: 112 });
    expect(evaluateProjectOverBudget({ ...facts, usedAmountMinor: 100_000 }, 100)).not.toBeNull();
    expect(evaluateProjectOverBudget({ ...facts, usedAmountMinor: 99_999 }, 100)).toBeNull();
  });

  it('an hours budget uses minutes; an unknown type never fires', () => {
    const hours = { ...facts, budgetType: 'hours', budgetMinutes: 600, usedMinutes: 660 };
    expect(evaluateProjectOverBudget(hours, 110)?.measure).toBe(110);
    expect(evaluateProjectOverBudget({ ...facts, budgetType: 'other' }, 100)).toBeNull();
  });
});

describe('stale task', () => {
  const facts = { workItemId: 'w1', projectId: 'p1', state: 'ready', updatedAt: daysFromNow(-14) };

  it('fires at N idle days (edge) and not a day earlier', () => {
    expect(evaluateStaleTask(facts, 14, NOW)).toMatchObject({ subjectId: 'w1', measure: 14 });
    expect(evaluateStaleTask({ ...facts, updatedAt: daysFromNow(-13) }, 14, NOW)).toBeNull();
  });

  it('backlog and finished work are never stale', () => {
    expect(evaluateStaleTask({ ...facts, state: 'backlog' }, 14, NOW)).toBeNull();
    expect(evaluateStaleTask({ ...facts, state: 'done' }, 14, NOW)).toBeNull();
  });
});

describe('unusual expense', () => {
  const facts = {
    expenseId: 'e1',
    projectId: 'p1',
    state: 'submitted',
    spentOn: '2026-11-18',
    amountBaseMinor: 30_000,
    baselineAmountsBaseMinor: [9_000, 10_000, 11_000],
  };

  it('fires at N times the category median (edge) and not below', () => {
    expect(evaluateUnusualExpense(facts, 3, NOW)).toMatchObject({ subjectId: 'e1', measure: 3 });
    expect(evaluateUnusualExpense({ ...facts, amountBaseMinor: 29_999 }, 3, NOW)).toBeNull();
  });

  it('needs three others, a recent spend and a submitted or approved state', () => {
    expect(
      evaluateUnusualExpense({ ...facts, baselineAmountsBaseMinor: [1, 1] }, 3, NOW),
    ).toBeNull();
    expect(evaluateUnusualExpense({ ...facts, spentOn: '2026-11-01' }, 3, NOW)).toBeNull();
    expect(evaluateUnusualExpense({ ...facts, state: 'draft' }, 3, NOW)).toBeNull();
    expect(evaluateUnusualExpense({ ...facts, state: 'rejected' }, 3, NOW)).toBeNull();
  });

  it('median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('approval waiting on the client', () => {
  const facts = {
    approvalId: 'a1',
    projectId: 'p1',
    state: 'viewed',
    requestedAt: daysFromNow(-3),
  };

  it('fires at N days of waiting (edge) and not before', () => {
    expect(evaluateApprovalWaitingOnClient(facts, 3, NOW)).toMatchObject({
      subjectId: 'a1',
      measure: 3,
    });
    const recent = { ...facts, requestedAt: new Date(daysFromNow(-3).getTime() + 1) };
    expect(evaluateApprovalWaitingOnClient(recent, 3, NOW)).toBeNull();
  });

  it('a decided approval waits on nobody', () => {
    expect(evaluateApprovalWaitingOnClient({ ...facts, state: 'approved' }, 3, NOW)).toBeNull();
  });
});

describe('approved time not invoiced', () => {
  const facts = { projectId: 'p1', minutes: 600, oldestSpentOn: '2026-11-05' };

  it('fires when the oldest approved entry is N days old (edge) and not before', () => {
    expect(evaluateApprovedTimeNotInvoiced(facts, 14, NOW)).toMatchObject({
      rule: 'approved_time_not_invoiced',
      subjectId: 'p1',
      measure: 14,
    });
    expect(
      evaluateApprovedTimeNotInvoiced({ ...facts, oldestSpentOn: '2026-11-06' }, 14, NOW),
    ).toBeNull();
  });

  it('no minutes, no signal', () => {
    expect(evaluateApprovedTimeNotInvoiced({ ...facts, minutes: 0 }, 14, NOW)).toBeNull();
    expect(evaluateApprovedTimeNotInvoiced({ ...facts, oldestSpentOn: null }, 14, NOW)).toBeNull();
  });
});
