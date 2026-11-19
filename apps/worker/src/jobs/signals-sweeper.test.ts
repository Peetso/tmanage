import { describe, expect, it } from 'vitest';
import { resolveSignalSettings } from '@tmanage/domain';
import type { SignalFinding, StoredSignalSetting } from '@tmanage/domain';
import {
  SIGNALS_SWEEP_LOCK,
  evaluateOrganization,
  runSignalsSweep,
  runSignalsSweepLoop,
  signalsToFile,
  subjectKey,
} from './signals-sweeper.js';
import type {
  OrganizationSignalFacts,
  SignalToFile,
  SignalsSweepStore,
} from './signals-sweeper.js';

const NOW = new Date('2026-11-19T10:00:00.000Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const DEFAULTS = resolveSignalSettings([]);

const EMPTY: OrganizationSignalFacts = {
  workItems: [],
  capacities: [],
  invoices: [],
  budgets: [],
  expenses: [],
  approvals: [],
  uninvoicedTime: [],
};

/** One organization where every rule has exactly one subject that fires and one that does not. */
const SEEDED: OrganizationSignalFacts = {
  workItems: [
    // Owner u1 (40 h/week): w-late fits on its own (20 h in 4 days) but not behind w-first (5 h).
    item('w-first', { dueAt: at(3), estimateMinutes: 300, ownerUserId: 'u1' }),
    item('w-late', { dueAt: at(4), estimateMinutes: 1200, ownerUserId: 'u1' }),
    item('w-fine', { dueAt: at(20), estimateMinutes: 60, ownerUserId: 'u1' }),
    // Owner u2 (40 h/week): 50 h due within the week — overloaded, not yet a deadline at risk.
    item('w-heavy', { dueAt: at(6), estimateMinutes: 3000, ownerUserId: 'u2' }),
    item('w-stale', { state: 'ready', updatedAt: at(-20) }),
    item('w-parked', { state: 'backlog', updatedAt: at(-90) }),
  ],
  capacities: [
    { membershipId: 'm1', userId: 'u1', weeklyMinutes: 2400 },
    { membershipId: 'm2', userId: 'u2', weeklyMinutes: 2400 },
  ],
  invoices: [
    {
      invoiceId: 'i-old',
      projectId: 'p1',
      state: 'sent',
      dueDate: '2026-11-01',
      totalMinor: 9,
      paidMinor: 0,
    },
    {
      invoiceId: 'i-new',
      projectId: 'p1',
      state: 'sent',
      dueDate: '2026-11-18',
      totalMinor: 9,
      paidMinor: 0,
    },
  ],
  budgets: [
    {
      projectId: 'p-over',
      budgetType: 'hours',
      budgetMinutes: 600,
      budgetAmountMinor: null,
      usedMinutes: 700,
      usedAmountMinor: 0,
    },
    {
      projectId: 'p-ok',
      budgetType: 'hours',
      budgetMinutes: 600,
      budgetAmountMinor: null,
      usedMinutes: 100,
      usedAmountMinor: 0,
    },
  ],
  expenses: [
    expense('e-1', '2026-10-01', 10_000),
    expense('e-2', '2026-10-10', 9_000),
    expense('e-3', '2026-10-20', 11_000),
    expense('e-big', '2026-11-18', 40_000),
    expense('e-small', '2026-11-17', 12_000),
  ],
  approvals: [
    { approvalId: 'a-wait', projectId: 'p1', state: 'requested', requestedAt: at(-5) },
    { approvalId: 'a-new', projectId: 'p1', state: 'requested', requestedAt: at(-1) },
  ],
  uninvoicedTime: [
    { projectId: 'p-unbilled', minutes: 600, oldestSpentOn: '2026-10-01' },
    { projectId: 'p-fresh', minutes: 600, oldestSpentOn: '2026-11-15' },
  ],
};

function item(
  id: string,
  patch: Partial<OrganizationSignalFacts['workItems'][number]>,
): OrganizationSignalFacts['workItems'][number] {
  return {
    workItemId: id,
    projectId: 'p1',
    state: 'in_progress',
    dueAt: null,
    updatedAt: NOW,
    ownerUserId: null,
    estimateMinutes: null,
    loggedMinutes: 0,
    ...patch,
  };
}

function expense(
  id: string,
  spentOn: string,
  amount: number,
): OrganizationSignalFacts['expenses'][number] {
  return {
    expenseId: id,
    projectId: 'p1',
    state: 'approved',
    spentOn,
    category: 'travel',
    amountBaseMinor: amount,
  };
}

const subjects = (findings: readonly SignalFinding[]) =>
  findings.map((finding) => `${finding.rule}:${finding.subjectId}`);

describe('evaluateOrganization', () => {
  it('runs all eight rules over seeded facts: one fires per rule, its sibling does not', () => {
    expect(subjects(evaluateOrganization(SEEDED, DEFAULTS, NOW))).toEqual([
      'deadline_at_risk:w-late',
      'overloaded_person:m2',
      'overdue_invoice:i-old',
      'project_over_budget:p-over',
      'stale_task:w-stale',
      'unusual_expense:e-big',
      'approval_waiting_on_client:a-wait',
      'approved_time_not_invoiced:p-unbilled',
    ]);
  });

  it('uses the owner’s threshold, not the default', () => {
    const strict = resolveSignalSettings([
      { rule: 'stale_task', enabled: true, threshold: 30, recipient: 'assignee' },
    ]);
    expect(subjects(evaluateOrganization(SEEDED, strict, NOW))).not.toContain('stale_task:w-stale');
  });

  it('no facts, no findings', () => {
    expect(evaluateOrganization(EMPTY, DEFAULTS, NOW)).toEqual([]);
  });
});

describe('signalsToFile', () => {
  const finding: SignalFinding = {
    rule: 'stale_task',
    subjectType: 'work_item',
    subjectId: 'w1',
    projectId: 'p1',
    measure: 20,
    threshold: 14,
  };

  it('one per subject per 24 h: a subject raised 23 h ago waits, 24 h ago goes again', () => {
    const recent = new Map([
      [subjectKey('stale_task', 'w1'), new Date(NOW.getTime() - 23 * 3_600_000)],
    ]);
    expect(signalsToFile([finding], DEFAULTS, recent, NOW)).toEqual([]);
    const old = new Map([[subjectKey('stale_task', 'w1'), new Date(NOW.getTime() - DAY)]]);
    expect(signalsToFile([finding], DEFAULTS, old, NOW)).toHaveLength(1);
  });

  it('a subject found twice in one run is filed once', () => {
    expect(signalsToFile([finding, finding], DEFAULTS, new Map(), NOW)).toHaveLength(1);
  });

  it('an off rule still files the signal but sends no notice', () => {
    const off = resolveSignalSettings([
      { rule: 'stale_task', enabled: false, threshold: 14, recipient: 'assignee' },
    ]);
    expect(signalsToFile([finding], off, new Map(), NOW)).toEqual([{ ...finding, notify: false }]);
    expect(signalsToFile([finding], DEFAULTS, new Map(), NOW)[0]?.notify).toBe(true);
  });
});

function fakeStore(patch: Partial<SignalsSweepStore> = {}): SignalsSweepStore & {
  readonly filed: { org: string; signals: readonly SignalToFile[] }[];
} {
  const filed: { org: string; signals: readonly SignalToFile[] }[] = [];
  return {
    filed,
    organizations: async () => ['org-a', 'org-b'],
    settings: async (): Promise<readonly StoredSignalSetting[]> => [],
    facts: async () => SEEDED,
    lastRaised: async () => new Map(),
    file: async (org, signals) => {
      filed.push({ org, signals });
      return signals.length;
    },
    ...patch,
  };
}

describe('runSignalsSweep', () => {
  it('sweeps only the organizations the store returns (flag on) and files their signals', async () => {
    const store = fakeStore();
    const result = await runSignalsSweep({ store, now: NOW });
    expect(result).toEqual({ organizations: 2, filed: 16, failed: 0 });
    expect(store.filed.map((entry) => entry.org)).toEqual(['org-a', 'org-b']);
  });

  it('one organization failing does not stop the others', async () => {
    const errors: unknown[] = [];
    const store = fakeStore({
      facts: async (org) => {
        if (org === 'org-a') throw new Error('boom');
        return SEEDED;
      },
    });
    const result = await runSignalsSweep({ store, now: NOW, onError: (e) => errors.push(e) });
    expect(result).toMatchObject({ filed: 8, failed: 1 });
    expect(errors).toHaveLength(1);
  });

  it('nothing found, nothing written', async () => {
    const store = fakeStore({ facts: async () => EMPTY });
    await runSignalsSweep({ store, now: NOW });
    expect(store.filed).toEqual([]);
  });

  it('the loop takes the signals-sweeper lock and stops on abort', async () => {
    const names: string[] = [];
    const controller = new AbortController();
    await runSignalsSweepLoop(
      {
        store: fakeStore(),
        lock: {
          run: async <T>(name: string, work: () => Promise<T>) => {
            names.push(name);
            const result = await work();
            controller.abort();
            return { ran: true as const, result };
          },
        },
      },
      controller.signal,
    );
    expect(names).toEqual([SIGNALS_SWEEP_LOCK]);
  });
});
