'use client';

import { useQuery } from '@tanstack/react-query';
import type { ApiClient } from '../../../lib/api/client';
import { fetchPlatformPricingSurvey } from '../../../lib/api/pricing-survey';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { PRICING_SURVEY_COPY } from '../../screens/pricing-survey-copy';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ACTIVITY_KEY } from './ActivityFrame';

const COPY = {
  title: 'Pricing answers',
  description:
    'What owners and admins said they would pay per person each month. Workspace names only, never a person.',
  answered: 'Answered',
  skipped: 'Skipped',
  colWorkspace: 'Workspace',
  colAnswer: 'Answer',
  colNote: 'Note',
  colDate: 'Date',
  skippedRow: 'Skipped',
  emptyTitle: 'No answers yet',
  emptyBody: 'The question shows to owners and admins after 14 days of use.',
  unknownWorkspace: 'Deleted workspace',
} as const;

type CopyKey = keyof typeof COPY;

/**
 * 57-17 WTP — the Platform admin list of willingness-to-pay answers, on the Growth page.
 * `GET /v1/platform/pricing-survey` (`platform.activity.view`): totals per band, then one row
 * per answer or skip, newest first (at most 200). No person is named.
 */
export function PricingAnswersCard({ api }: { api: ApiClient }) {
  const tOr = useTOr();
  const copy = (key: CopyKey) => tOr(`PlatformPricing.${key}`, COPY[key]);
  const band = (key: keyof typeof PRICING_SURVEY_COPY) =>
    tOr(`PricingSurvey.${key}`, PRICING_SURVEY_COPY[key]);
  const format = useDisplayFormatters();
  const answers = useQuery({
    queryKey: [...ACTIVITY_KEY, 'pricing-survey'],
    queryFn: () => fetchPlatformPricingSurvey(api),
  });

  return (
    <section className="tm-cc-card" aria-labelledby="tm-pricing-answers-title">
      <h2 id="tm-pricing-answers-title" className="tm-cc-card__title">
        {copy('title')}
      </h2>
      <p className="tm-r44-sub">{copy('description')}</p>
      {answers.isPending ? <PlatformPageState state="loading" /> : null}
      {answers.isError ? (
        <PlatformPageState
          state="error"
          error={answers.error}
          onRetry={() => void answers.refetch()}
        />
      ) : null}
      {answers.data && answers.data.rows.length === 0 ? (
        <PlatformPageState state="empty" title={copy('emptyTitle')} body={copy('emptyBody')} />
      ) : null}
      {answers.data && answers.data.rows.length > 0 ? (
        <>
          <ul className="tm-cc-metrics tm-r44-kpis" aria-label={copy('title')}>
            {answers.data.byBand.map((entry) => (
              <li key={entry.band} className="tm-cc-metric">
                <p className="tm-cc-metric__source">
                  <bdi>{band(`band_${entry.band}`)}</bdi>
                </p>
                <p className="tm-cc-metric__value">{format.number(entry.count)}</p>
              </li>
            ))}
            <li className="tm-cc-metric">
              <p className="tm-cc-metric__source">{copy('skipped')}</p>
              <p className="tm-cc-metric__value">{format.number(answers.data.skipped)}</p>
            </li>
          </ul>
          <table className="tm-table tm-cc-table">
            <thead>
              <tr>
                <th scope="col">{copy('colWorkspace')}</th>
                <th scope="col">{copy('colAnswer')}</th>
                <th scope="col">{copy('colNote')}</th>
                <th scope="col">{copy('colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {answers.data.rows.map((row, index) => (
                <tr key={`${row.answeredAt}-${String(index)}`}>
                  <th scope="row">{row.organizationName ?? copy('unknownWorkspace')}</th>
                  <td>
                    {row.outcome === 'skipped' || row.band === null ? (
                      copy('skippedRow')
                    ) : (
                      <bdi>{band(`band_${row.band}`)}</bdi>
                    )}
                  </td>
                  <td>{row.note ?? '—'}</td>
                  <td className="tm-cc-cell-mono">{format.day(row.answeredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
