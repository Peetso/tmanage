import { describe, expect, it } from 'vitest';
import {
  BRIEFING_GROUP_ORDER,
  assembleBriefing,
  briefingAudience,
  briefingReasonOf,
  briefingSignalVisible,
  briefingSubjectKey,
  briefingViewerBase,
  buildBriefing,
} from './briefing.js';
import type { BriefingSource, BriefingSubject, BriefingViewer, OpenSignal } from './briefing.js';
import { SIGNAL_RULES, SIGNAL_RULE_KEYS } from './signal-catalog.js';
import type { SignalRuleKey } from './signal-catalog.js';

const SUBJECT: BriefingSubject = {
  title: 'Cedar Foods brand refresh',
  context: null,
  amount: null,
  category: null,
  deliverableId: null,
};

let next = 0;
function signal(
  rule: SignalRuleKey,
  projectId: string | null,
  measure = 10,
  subjectId = `s${String((next += 1))}`,
): OpenSignal {
  return {
    signalId: `sig-${subjectId}`,
    rule,
    subjectType: SIGNAL_RULES[rule].subjectType,
    subjectId,
    projectId,
    measure,
    threshold: 1,
  };
}

function resolved(signals: readonly OpenSignal[]): Map<string, BriefingSubject> {
  return new Map(signals.map((s) => [briefingSubjectKey(s.subjectType, s.subjectId), SUBJECT]));
}

const viewer = (patch: Partial<BriefingViewer> = {}): BriefingViewer => ({
  companyWide: false,
  finance: false,
  projectIds: new Set(),
  teamMembershipIds: new Set(),
  ...patch,
});

const OWNER = viewer({ companyWide: true, finance: true });
const ADMIN_NO_FINANCE = viewer({ companyWide: true });
const LEAD = viewer({ projectIds: new Set(['p1']), teamMembershipIds: new Set(['m-team']) });
const LEAD_FINANCE = viewer({ ...LEAD, finance: true });
const MEMBER = viewer();

/** One signal per rule on p1, one per rule on p2, and the overload of a team and an outside person. */
const ALL: readonly OpenSignal[] = [
  ...SIGNAL_RULE_KEYS.filter((rule) => rule !== 'overloaded_person').flatMap((rule) => [
    signal(rule, 'p1'),
    signal(rule, 'p2'),
  ]),
  signal('overloaded_person', null, 120, 'm-team'),
  signal('overloaded_person', null, 130, 'm-other'),
];

const groupsOf = (v: BriefingViewer) =>
  Object.fromEntries(buildBriefing(ALL, resolved(ALL), v).map((g) => [g.group, g.count]));

describe('briefing scope matrix', () => {
  it('owner: the whole company, money included', () => {
    expect(groupsOf(OWNER)).toEqual({
      projects_at_risk: 2,
      money_to_collect: 2,
      money_to_invoice: 2,
      people_overloaded: 2,
      waiting_on_clients: 2,
      over_budget: 2,
      stale_work: 2,
      unusual_expenses: 2,
    });
    expect(briefingAudience(OWNER)).toBe('company');
  });

  it('admin without finance: the whole company, money groups absent', () => {
    expect(groupsOf(ADMIN_NO_FINANCE)).toEqual({
      projects_at_risk: 2,
      people_overloaded: 2,
      waiting_on_clients: 2,
      stale_work: 2,
    });
  });

  it('lead: only their projects and their people; no money without finance', () => {
    expect(groupsOf(LEAD)).toEqual({
      projects_at_risk: 1,
      people_overloaded: 1,
      waiting_on_clients: 1,
      stale_work: 1,
    });
    expect(briefingAudience(LEAD)).toBe('team');
  });

  it('lead with finance: their projects money too, never another project', () => {
    expect(groupsOf(LEAD_FINANCE)).toEqual({
      projects_at_risk: 1,
      money_to_collect: 1,
      money_to_invoice: 1,
      people_overloaded: 1,
      waiting_on_clients: 1,
      over_budget: 1,
      stale_work: 1,
      unusual_expenses: 1,
    });
  });

  it('member who leads nothing: no briefing at all', () => {
    expect(groupsOf(MEMBER)).toEqual({});
    expect(briefingAudience(MEMBER)).toBe('none');
  });

  it('a lead never sees a money signal that has no project', () => {
    const loose = [signal('overdue_invoice', null)];
    expect(buildBriefing(loose, resolved(loose), LEAD_FINANCE)).toEqual([]);
    expect(buildBriefing(loose, resolved(loose), OWNER)).toHaveLength(1);
  });
});

describe('buildBriefing', () => {
  it('count equals the lines the viewer can open: an unresolved record is dropped before counting', () => {
    const signals = [
      signal('stale_task', 'p1'),
      signal('stale_task', 'p1'),
      signal('stale_task', 'p1'),
    ];
    const subjects = resolved(signals.slice(0, 2));
    const [group] = buildBriefing(signals, subjects, OWNER);
    expect(group).toMatchObject({ group: 'stale_work', count: 2, more: 0 });
    expect(group?.lines).toHaveLength(2);
  });

  it('three lines a group, the rest is "and N more", most pressing first', () => {
    const signals = [5, 20, 9, 14, 30].map((days) => signal('stale_task', 'p1', days));
    const [group] = buildBriefing(signals, resolved(signals), OWNER);
    expect(group?.lines.map((line) => line.measure)).toEqual([30, 20, 14]);
    expect(group).toMatchObject({ count: 5, more: 2, path: '/work' });
  });

  it('deadlines: the nearest first', () => {
    const signals = [4, 1, 3].map((days) => signal('deadline_at_risk', 'p1', days));
    const [group] = buildBriefing(signals, resolved(signals), OWNER);
    expect(group?.lines.map((line) => line.measure)).toEqual([1, 3, 4]);
  });

  it('groups keep the drawn order; an empty group is absent', () => {
    const signals = [signal('unusual_expense', 'p1'), signal('deadline_at_risk', 'p1')];
    const groups = buildBriefing(signals, resolved(signals), OWNER).map((g) => g.group);
    expect(groups).toEqual(['projects_at_risk', 'unusual_expenses']);
    expect(BRIEFING_GROUP_ORDER).toHaveLength(8);
  });

  it('every line links to its record', () => {
    const cases: readonly [SignalRuleKey, string][] = [
      ['deadline_at_risk', '/work/x1'],
      ['overloaded_person', '/people/x1'],
      ['overdue_invoice', '/finance/invoices/x1'],
      ['project_over_budget', '/projects/x1'],
      ['unusual_expense', '/finance/expenses'],
      ['approval_waiting_on_client', '/projects/p1/deliverables/d1'],
    ];
    for (const [rule, path] of cases) {
      const one = [signal(rule, 'p1', 10, 'x1')];
      const subjects = new Map([
        [
          briefingSubjectKey(SIGNAL_RULES[rule].subjectType, 'x1'),
          { ...SUBJECT, deliverableId: 'd1' },
        ],
      ]);
      expect(buildBriefing(one, subjects, OWNER)[0]?.lines[0]?.path).toBe(path);
    }
  });
});

describe('briefingViewerBase (62-A1c: the card and the mail read the viewer the same way)', () => {
  it('a lead is a project member holding project.manage; finance is finance.view', () => {
    const lead = briefingViewerBase({
      hasOrgWideScope: false,
      holds: (c) => c === 'project.manage',
      projectIds: ['p1'],
      membershipId: 'm1',
    });
    expect([...lead.projectIds]).toEqual(['p1']);
    expect(lead.finance).toBe(false);
    const member = briefingViewerBase({
      hasOrgWideScope: false,
      holds: () => false,
      projectIds: ['p1'],
      membershipId: 'm1',
    });
    expect([...member.projectIds]).toEqual([]);
  });
});

describe('assembleBriefing', () => {
  function source(sweptAt: Date | null, signals: readonly OpenSignal[]) {
    const calls: string[] = [];
    const reads: BriefingSource = {
      team: async (ids) => (calls.push(`team:${ids.join(',')}`), new Set(['m-team'])),
      lastSweep: async () => (calls.push('lastSweep'), sweptAt),
      openSignals: async () => (calls.push('openSignals'), signals),
      subjects: async (visible) => (
        calls.push(`subjects:${String(visible.length)}`),
        resolved(visible)
      ),
    };
    return { reads, calls };
  }
  const SWEPT = new Date('2026-11-19T08:00:00.000Z');
  const base = (patch: Partial<Parameters<typeof briefingViewerBase>[0]> = {}) =>
    briefingViewerBase({
      hasOrgWideScope: false,
      holds: () => false,
      projectIds: [],
      membershipId: 'm1',
      ...patch,
    });

  it('company-wide: no team read; as of the last sweep; groups as buildBriefing', async () => {
    const { reads, calls } = source(SWEPT, ALL);
    const owner = base({ hasOrgWideScope: true, holds: () => true });
    const briefing = await assembleBriefing(reads, owner);
    expect(briefing.audience).toBe('company');
    expect(briefing.asOf).toBe(SWEPT);
    expect(briefing.groups).toEqual(buildBriefing(ALL, resolved(ALL), OWNER));
    expect(calls.some((c) => c.startsWith('team'))).toBe(false);
  });

  it('only the visible signals are resolved', async () => {
    const { reads, calls } = source(SWEPT, ALL);
    await assembleBriefing(
      reads,
      base({ holds: (c) => c === 'project.manage', projectIds: ['p1'] }),
    );
    const visible = ALL.filter((s) =>
      briefingSignalVisible(s, { ...LEAD, teamMembershipIds: new Set(['m-team']) }),
    );
    expect(calls).toContain(`subjects:${String(visible.length)}`);
  });

  it('before the first sweep: the audience, no time, nothing listed or resolved', async () => {
    const { reads, calls } = source(null, ALL);
    const briefing = await assembleBriefing(reads, base({ hasOrgWideScope: true }));
    expect(briefing).toEqual({ audience: 'company', asOf: null, groups: [] });
    expect(calls).toEqual(['lastSweep']);
  });
});

describe('briefingReasonOf (the sentence the card and the mail each say in words)', () => {
  const amount = { minor: 420_000, currency: 'USD' };
  it.each([
    ['deadline_at_risk', -3, null, 'dueLate', { days: 3 }],
    ['deadline_at_risk', -1, null, 'dueLateOne', {}],
    ['deadline_at_risk', 0, null, 'dueToday', {}],
    ['deadline_at_risk', 1, null, 'dueTomorrow', {}],
    ['deadline_at_risk', 4, null, 'dueIn', { days: 4 }],
    ['overloaded_person', 115, null, 'overloaded', { percent: 115 }],
    ['overdue_invoice', 12, null, 'overdue', { days: 12 }],
    ['overdue_invoice', 12, amount, 'overdueAmount', { days: 12 }],
    ['project_over_budget', 112, null, 'overBudget', { percent: 112 }],
    ['stale_task', 16, null, 'stale', { days: 16 }],
    ['unusual_expense', 4, amount, 'unusualExpenseAmount', { times: 4 }],
    ['approval_waiting_on_client', 5, null, 'waitingOnClient', { days: 5 }],
    ['approved_time_not_invoiced', 14, null, 'notInvoiced', { days: 14 }],
  ] as const)('%s %d', (rule, measure, money, key, figures) => {
    const reason = briefingReasonOf({ rule, measure, amount: money });
    expect(reason).toEqual({ key, figures, amount: key.endsWith('Amount') ? amount : null });
  });
});
