import { describe, expect, it } from 'vitest';
import {
  growthRunDue,
  mrrRollups,
  organizationRollups,
  retentionRollups,
  type OrgGrowthFacts,
} from './growth-rollup.js';

const at = (s: string) => new Date(`${s}Z`);
const org = (key: string, over: Partial<OrgGrowthFacts> = {}): OrgGrowthFacts => ({
  key,
  createdAt: at('2026-09-07T10:00:00'),
  source: null,
  firstProjectAt: null,
  internalInvites7d: 0,
  workItems7d: 0,
  convertedMessages7d: 0,
  completedWork7d: 0,
  clientLinkedAt: null,
  approvalDecidedAt: null,
  ...over,
});
const full = { firstProjectAt: at('2026-09-07T12:00:00'), internalInvites7d: 3, workItems7d: 10 };
const fixture = [
  org('a', { ...full, convertedMessages7d: 1, completedWork7d: 1, source: 'ads' }),
  org('b', { ...full, completedWork7d: 1, clientLinkedAt: at('2026-09-10T00:00:00') }),
  org('c', { firstProjectAt: at('2026-09-20T00:00:00') }),
  org('d', { source: 'BAD SOURCE' }),
];
const pick = (rows: ReturnType<typeof organizationRollups>, metric: string, dim = '') =>
  rows.find((r) => r.metric === metric && r.dimension === dim)?.value;

describe('growth rollups (57-14)', () => {
  it('counts the 7-day funnel cumulatively, sources and the first-project median', () => {
    const rows = organizationRollups('week', fixture);
    expect(rows.every((r) => r.periodStart === '2026-09-07')).toBe(true);
    expect(
      ['org', 'project', 'invites_3', 'work_items_10', 'converted_message', 'completed_work'].map(
        (step) => pick(rows, 'activation_7d', step),
      ),
    ).toEqual([4, 2, 2, 2, 1, 1]);
    expect(pick(rows, 'activation_7d_rate')).toBe(0.25);
    expect(pick(rows, 'service_activation_14d', 'client_linked')).toBe(1);
    expect([
      pick(rows, 'signups'),
      pick(rows, 'signups', 'ads'),
      pick(rows, 'signups', 'unattributed'),
    ]).toEqual([4, 1, 3]);
    expect(pick(rows, 'time_to_first_project_hours', 'p50')).toBe(2);
  });

  it('keeps cohort retention to fully passed weeks', () => {
    const actors = [
      { key: 'a', actorHash: 'h1', weekStart: '2026-09-07' },
      { key: 'a', actorHash: 'h2', weekStart: '2026-09-07' },
      { key: 'a', actorHash: 'h1', weekStart: '2026-09-14' },
      { key: 'a', actorHash: 'h3', weekStart: '2026-09-14' },
    ];
    const rows = retentionRollups(fixture, actors, at('2026-09-28T00:00:00'));
    expect(rows.map((r) => [r.dimension, r.value, r.sampleCount])).toEqual([
      ['w1', 0.5, 2],
      ['w2', 0, 2],
    ]);
  });

  it('prices MRR from two plans only when billing is paid', () => {
    const subs = [
      { planId: 'starter', createdAt: at('2026-10-02T00:00:00') },
      { planId: 'pro', createdAt: at('2026-08-01T00:00:00') },
      { planId: 'free', createdAt: at('2026-10-03T00:00:00') },
    ];
    const paid = mrrRollups(subs, 'paid', at('2026-10-15T00:00:00'));
    expect(pick(paid, 'mrr_cents')).toBe(6800);
    expect(pick(paid, 'new_mrr_cents')).toBe(1900);
    expect(pick(paid, 'mrr_cents', 'plan:studio')).toBe(4900);
    expect(pick(mrrRollups(subs, 'beta_free', at('2026-10-15T00:00:00')), 'mrr_cents')).toBe(0);
  });

  it('runs on boot when stale and once nightly after 02:00 UTC', () => {
    expect(growthRunDue(null, at('2026-10-15T01:00:00'))).toBe(true);
    expect(growthRunDue(at('2026-10-15T02:05:00'), at('2026-10-15T09:00:00'))).toBe(false);
    expect(growthRunDue(at('2026-10-15T02:05:00'), at('2026-10-16T02:01:00'))).toBe(true);
  });
});
