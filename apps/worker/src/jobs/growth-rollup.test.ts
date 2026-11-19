import { describe, expect, it } from 'vitest';
import {
  activeCompanyRollups,
  aiRollups,
  firstProjectFinishedRollups,
  growthRunDue,
  mrrRollups,
  organizationRollups,
  retentionRollups,
  runGrowthRollup,
  type GrowthRollupStore,
  type OrgGrowthFacts,
  type RollupRow,
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
  firstProjectFinishedAt: null,
  firstInvoiceIssuedAt: null,
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

describe('62-A3 missing growth figures (B14)', () => {
  it('counts companies with 2+ internal people active, out of those existing by the period end', () => {
    const actors = [
      { key: 'a', actorHash: 'h1', periodStart: '2026-09-07' },
      { key: 'a', actorHash: 'h2', periodStart: '2026-09-07' },
      { key: 'b', actorHash: 'h3', periodStart: '2026-09-07' }, // one person: not active
      { key: 'b', actorHash: 'h3', periodStart: '2026-09-07' },
      { key: 'c', actorHash: 'h4', periodStart: '2026-09-14' },
      { key: 'c', actorHash: 'h5', periodStart: '2026-09-14' },
    ];
    const orgs = [org('a'), org('b'), org('c', { createdAt: at('2026-09-15T00:00:00') })];
    const rows = activeCompanyRollups('week', actors, orgs, 10);
    expect(rows.map((r) => [r.periodStart, r.value, r.sampleCount])).toEqual([
      ['2026-09-07', 1, 9], // c signed up after that week ended
      ['2026-09-14', 1, 10],
    ]);
  });

  it('rates first projects finished within 30 / 60 days over sign-ups whose window has passed', () => {
    const orgs = [
      org('a', { firstProjectFinishedAt: at('2026-09-20T00:00:00') }), // day 13
      org('b', { firstProjectFinishedAt: at('2026-10-27T00:00:00') }), // day 50
      org('c'),
      org('d', { firstProjectFinishedAt: at('2026-09-01T00:00:00') }), // before sign-up
    ];
    const day40 = firstProjectFinishedRollups('month', orgs, at('2026-10-17T10:00:00'));
    expect(day40.map((r) => [r.dimension, r.value, r.sampleCount])).toEqual([['30d', 0.25, 4]]);
    const day70 = firstProjectFinishedRollups('month', orgs, at('2026-11-16T10:00:00'));
    expect(day70.map((r) => [r.dimension, r.value])).toEqual([
      ['30d', 0.25],
      ['60d', 0.5],
    ]);
  });

  it('takes the first outcome as the earlier of an approval decided and an invoice issued', () => {
    const orgs = [
      org('a', { approvalDecidedAt: at('2026-09-08T10:00:00') }), // 24 h
      org('b', {
        approvalDecidedAt: at('2026-09-12T10:00:00'),
        firstInvoiceIssuedAt: at('2026-09-10T10:00:00'), // 72 h, earlier than the approval
      }),
      org('c', { firstInvoiceIssuedAt: at('2026-09-17T10:00:00') }), // 240 h
      org('d'),
    ];
    const rows = organizationRollups('week', orgs);
    const outcome = rows.find((r) => r.metric === 'time_to_first_outcome_hours');
    expect(outcome).toMatchObject({ dimension: 'p50', value: 72, sampleCount: 3 });
  });

  it('writes AI figures only for periods that have any, credits rounded up from real spend', () => {
    const tasks = [
      { day: '2026-11-03', run: 3, completed: 2, undone: 1 },
      { day: '2026-11-18', run: 2, completed: 1, undone: 0 },
    ];
    const costs = [
      { day: '2026-11-03', costMicroUsd: 1500 },
      { day: '2026-11-18', costMicroUsd: 1 },
    ];
    const rows = aiRollups('month', tasks, costs);
    expect(rows.map((r) => [r.metric, r.value])).toEqual([
      ['ai_tasks_run', 5],
      ['ai_tasks_completed', 3],
      ['ai_tasks_undone', 1],
      ['ai_cost_micro_usd', 1501],
      ['ai_credits_used', 2],
    ]);
    expect(rows.every((r) => r.periodStart === '2026-11-01')).toBe(true);
    expect(aiRollups('week', [], [])).toEqual([]);
  });

  it('writes counts, rates and durations only: no company id or actor hash reaches the table', async () => {
    const key = '0191d6a4-7a4b-7c1e-9f00-aaaaaaaaaaaa';
    const written: RollupRow[] = [];
    const store: GrowthRollupStore = {
      lastComputedAt: async () => null,
      organizations: async () => [
        org(key, {
          createdAt: at('2026-10-01T10:00:00'),
          source: 'ads',
          approvalDecidedAt: at('2026-10-02T10:00:00'),
          firstProjectFinishedAt: at('2026-10-05T10:00:00'),
        }),
      ],
      actorWeeks: async () => [
        { key, actorHash: 'hash-one', weekStart: '2026-09-28' },
        { key, actorHash: 'hash-two', weekStart: '2026-09-28' },
      ],
      actorMonths: async () => [
        { key, actorHash: 'hash-one', periodStart: '2026-10-01' },
        { key, actorHash: 'hash-two', periodStart: '2026-10-01' },
      ],
      companiesTotal: async () => 1,
      aiTaskDays: async () => [{ day: '2026-11-03', run: 1, completed: 1, undone: 0 }],
      aiCostDays: async () => [{ day: '2026-11-03', costMicroUsd: 900 }],
      subscriptions: async () => [],
      approvals: async () => [],
      billingModeSetting: async () => null,
      upsert: async (rows) => (written.push(...rows), rows.length),
      deleteBefore: async () => 0,
      reportSent: async () => true,
    };
    await runGrowthRollup({
      store,
      mailer: null,
      alertEmails: [],
      composeReport: () => ({ subject: '', text: '' }),
      env: {},
      now: () => at('2026-11-19T03:00:00'),
    });
    const metrics = new Set(written.map((r) => r.metric));
    for (const metric of [
      'active_companies',
      'first_project_finished_rate',
      'time_to_first_outcome_hours',
      'ai_tasks_run',
      'ai_credits_used',
    ]) {
      expect(metrics.has(metric), metric).toBe(true);
    }
    const text = JSON.stringify(written);
    expect(text).not.toContain(key);
    expect(text).not.toContain('hash-');
    // Dimensions are fixed vocabulary (steps, windows, percentiles, slugs): never an id.
    for (const row of written) expect(row.dimension).toMatch(/^[a-z0-9_:]*$/);
  });
});
