import { describe, expect, it } from 'vitest';
import { composeMonthlyGtmReport } from './monthly_gtm_report.js';

describe('monthly_gtm_report (57-14)', () => {
  it('states the numbers, says what is not measured, and carries the CSV', () => {
    const mail = composeMonthlyGtmReport({
      month: '2026-10',
      generatedAt: new Date('2026-11-01T02:00:00Z'),
      signups: 4,
      signupsBySource: [{ source: 'unattributed', count: 4 }],
      activation: { steps: [{ step: 'org', count: 4 }], rate: 0.25 },
      serviceActivation: { steps: [{ step: 'client_linked', count: 1 }], rate: 0 },
      timeToFirstProjectP50Hours: 2,
      approvalTurnaroundHours: null,
      mrr: { cents: 0, newCents: 0, paidSubscriptions: 0, billingMode: 'beta_free' },
      rows: [
        {
          periodKind: 'month',
          periodStart: '2026-10-01',
          metric: 'signups',
          dimension: '=x',
          value: 4,
          sampleCount: 4,
        },
      ],
    });
    expect(mail.subject).toBe('[TManage growth] 2026-10: 4 sign-up(s)');
    expect(mail.text).toMatchInlineSnapshot(`
      "Growth report for 2026-10 (UTC), generated 2026-11-01T02:00:00.000Z.

      Sign-ups: 4
        - unattributed: 4

      7-day activation: 25.0 %
        - org: 4

      14-day service activation: 0.0 %
        - client_linked: 1

      Time to first project (median): 2.0 h
      Client approval turnaround: no decided approvals

      MRR: $0.00 from 0 paid subscription(s), new $0.00 (source: subscriptions, billing mode beta_free)
      Not measured yet: expansion and churn MRR, checkout conversion by country, founding counter, referrals (billing events and referrals are not built).

      --- growth-2026-10.csv ---
      periodKind,periodStart,metric,dimension,value,sampleCount
      month,2026-10-01,signups,'=x,4,4
      --- end of csv ---

      Details: Platform → Activity → Growth."
    `);
  });
});
