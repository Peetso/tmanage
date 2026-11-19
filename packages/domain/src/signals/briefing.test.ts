import { describe, expect, it } from 'vitest';
import {
  BRIEFING_GROUP_ORDER,
  briefingAudience,
  briefingSubjectKey,
  buildBriefing,
} from './briefing.js';
import type { BriefingSubject, BriefingViewer, OpenSignal } from './briefing.js';
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
