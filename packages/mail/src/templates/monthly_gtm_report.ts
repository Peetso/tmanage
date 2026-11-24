import { renderTextReport } from '../layout.js';
/**
 * 57-14 — `monthly_gtm_report`: the monthly go-to-market numbers (English only, per plan), sent on
 * the 1st by the worker's growth job to `ALERT_EMAILS` through the mail queue's normal lane (an
 * unlisted template key travels `transactional`, `lanes.ts`). Off when `ALERT_EMAILS` is empty.
 *
 * The same numbers the Platform admin Growth route returns, as text, with the month's rollup rows
 * as CSV. The port carries no attachments (`MailMessage` is text, optional HTML), so the CSV rides
 * at the end of the body between two marker lines, ready to save as `growth-<month>.csv`.
 *
 * Counts, rates and durations only — never an organization id, an actor hash or any content
 * (PRIV-06). A number that is not measured yet says so; nothing here is estimated.
 */

export interface GtmFunnelStep {
  readonly step: string;
  readonly count: number;
}

export interface GtmRollupCsvRow {
  readonly periodKind: string;
  readonly periodStart: string;
  readonly metric: string;
  readonly dimension: string;
  readonly value: number;
  readonly sampleCount: number;
}

export interface MonthlyGtmReportInput {
  /** `YYYY-MM`, the month the report covers. */
  readonly month: string;
  readonly generatedAt: Date;
  readonly signups: number;
  readonly signupsBySource: readonly { readonly source: string; readonly count: number }[];
  readonly activation: { readonly steps: readonly GtmFunnelStep[]; readonly rate: number | null };
  readonly serviceActivation: {
    readonly steps: readonly GtmFunnelStep[];
    readonly rate: number | null;
  };
  readonly timeToFirstProjectP50Hours: number | null;
  readonly approvalTurnaroundHours: {
    readonly p50: number;
    readonly p75: number;
    readonly p90: number;
  } | null;
  readonly mrr: {
    readonly cents: number;
    readonly newCents: number;
    readonly paidSubscriptions: number;
    readonly billingMode: string;
  } | null;
  readonly rows: readonly GtmRollupCsvRow[];
}

export const MONTHLY_GTM_REPORT_TEMPLATE_KEY = 'monthly_gtm_report';

export const GTM_CSV_HEADER = [
  'periodKind',
  'periodStart',
  'metric',
  'dimension',
  'value',
  'sampleCount',
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 quoting with the spreadsheet formula guard (the audit export's rule). */
export function gtmCsvCell(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function gtmRollupsToCsv(rows: readonly GtmRollupCsvRow[]): string {
  const lines = [GTM_CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.periodKind,
        row.periodStart,
        row.metric,
        row.dimension,
        String(row.value),
        String(row.sampleCount),
      ]
        .map(gtmCsvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

const percent = (rate: number | null): string =>
  rate === null ? 'no sign-ups' : `${(Math.round(rate * 1000) / 10).toFixed(1)} %`;
const hours = (value: number | null): string =>
  value === null ? 'not enough data' : `${(Math.round(value * 10) / 10).toFixed(1)} h`;
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function funnel(steps: readonly GtmFunnelStep[]): string[] {
  return steps.map((step) => `  - ${step.step}: ${String(step.count)}`);
}

export function composeMonthlyGtmReport(input: MonthlyGtmReportInput): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
} {
  const subject = `[TManage growth] ${input.month}: ${String(input.signups)} sign-up(s)`;
  const sources =
    input.signupsBySource.length === 0
      ? ['  - none']
      : input.signupsBySource.map((row) => `  - ${row.source}: ${String(row.count)}`);
  const turnaround = input.approvalTurnaroundHours;
  const text = [
    `Growth report for ${input.month} (UTC), generated ${input.generatedAt.toISOString()}.`,
    '',
    `Sign-ups: ${String(input.signups)}`,
    ...sources,
    '',
    `7-day activation: ${percent(input.activation.rate)}`,
    ...funnel(input.activation.steps),
    '',
    `14-day service activation: ${percent(input.serviceActivation.rate)}`,
    ...funnel(input.serviceActivation.steps),
    '',
    `Time to first project (median): ${hours(input.timeToFirstProjectP50Hours)}`,
    turnaround === null
      ? 'Client approval turnaround: no decided approvals'
      : `Client approval turnaround: p50 ${hours(turnaround.p50)}, p75 ${hours(turnaround.p75)}, ` +
        `p90 ${hours(turnaround.p90)}`,
    '',
    input.mrr === null
      ? 'MRR: not computed this month'
      : `MRR: ${dollars(input.mrr.cents)} from ${String(input.mrr.paidSubscriptions)} paid ` +
        `subscription(s), new ${dollars(input.mrr.newCents)} (source: subscriptions, billing ` +
        `mode ${input.mrr.billingMode})`,
    'Not measured yet: expansion and churn MRR, checkout conversion by country, founding ' +
      'counter, referrals (billing events and referrals are not built).',
    '',
    `--- growth-${input.month}.csv ---`,
    gtmRollupsToCsv(input.rows).trimEnd().split('\r\n').join('\n'),
    '--- end of csv ---',
    '',
    'Details: Platform → Activity → Growth.',
  ].join('\n');
  // MAILDESIGN: the same words in the shared layout.
  return { subject, text, html: renderTextReport(subject, text) };
}
