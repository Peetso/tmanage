'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useClientNames } from '../finance/InvoiceStateWord';
import { listQuotes, type QuoteStatus } from './QuoteApi';
import { QUOTE_FILTERS, quoteCapsule, type QuoteFilter } from './QuoteRules';
import '../../../styles/screens/finance-ledger.css';
import '../../../styles/screens/quotes.css';

export interface QuoteListScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const FILTER_WORDS: Record<QuoteFilter, readonly [string, string]> = {
  all: ['Quotes.filterAll', 'All'],
  draft: ['Quotes.filterDraft', 'Draft'],
  sent: ['Quotes.filterSent', 'Sent'],
  accepted: ['Quotes.filterAccepted', 'Accepted'],
  declined: ['Quotes.filterDeclined', 'Declined'],
};

/** The capsule word for each status: catalog key and English shown until the key is merged. */
export const STATUS_WORDS: Record<QuoteStatus, readonly [string, string]> = {
  draft: ['Quotes.statusDraft', 'Draft'],
  sent: ['Quotes.statusSent', 'Sent'],
  accepted: ['Quotes.statusAccepted', 'Accepted'],
  declined: ['Quotes.statusDeclined', 'Declined'],
  expired: ['Quotes.statusExpired', 'Expired'],
};

/**
 * **Quotes** — the quote list (A12), drawn as the R31 L04 Figma frame "Quotes · List · Main" and
 * "… Empty": the status filters and one row per quote with its client, validity, total and state.
 * Reads `GET …/quotes` on `project.manage`; a caller without it sees the API's refusal.
 */
export function QuoteListScreen({
  organizationSlug,
  organizationName,
  client,
}: QuoteListScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();
  const [filter, setFilter] = useState<QuoteFilter>('all');
  const clientNames = useClientNames(api, organizationSlug);

  const quotes = useQuery({
    queryKey: ['quotes', organizationSlug, filter],
    queryFn: () => listQuotes(api, organizationSlug, filter === 'all' ? null : filter),
  });
  const rows = quotes.data ?? [];
  const waiting = rows.filter((row) => row.status === 'sent').length;
  const newHref = `/${organizationSlug}/quotes/new`;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="finance"
      eyebrow={tOr('FinanceIndex.eyebrow', 'Finance')}
      title={tOr('Quotes.title', 'Quotes')}
      titleMeta={
        rows.length > 0
          ? `${rows.length} ${tOr('Quotes.countWord', 'quotes')} · ${waiting} ${tOr('Quotes.waitingWord', 'waiting on the client')}`
          : undefined
      }
      actions={
        <Link className="tm-button tm-button--ink tm-button--default" href={newHref}>
          {tOr('Quotes.new', 'New quote')}
        </Link>
      }
    >
      <div className="tm-stack">
        <div
          className="tm-chip-row"
          role="group"
          aria-label={tOr('Quotes.filterLabel', 'Filter by state')}
        >
          {QUOTE_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className="tm-chip"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {tOr(...FILTER_WORDS[option])}
            </button>
          ))}
        </div>

        {quotes.isPending ? (
          <LoadingRegion
            label={tOr('Quotes.loading', 'Loading quotes')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {quotes.isError ? (
          <InlineAlert tone="danger" title={tOr('Quotes.errorTitle', 'Quotes could not load')} live>
            {describe(quotes.error)}
          </InlineAlert>
        ) : null}

        {quotes.isSuccess && rows.length === 0 ? (
          <div className="tm-card tm-card--empty tm-stack tm-stack--tight">
            <InlineAlert tone="neutral" title={tOr('Quotes.emptyTitle', 'No quotes yet')}>
              {tOr(
                'Quotes.emptyBody',
                'Write a quote with lines, tax and a validity date, then send it to the client to accept online.',
              )}
            </InlineAlert>
            <div className="tm-row">
              <Link className="tm-button tm-button--ink tm-button--compact" href={newHref}>
                {tOr('Quotes.new', 'New quote')}
              </Link>
            </div>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="tm-fin-table-card">
            <table className="tm-table">
              <caption className="tm-visually-hidden">{tOr('Quotes.title', 'Quotes')}</caption>
              <thead>
                <tr>
                  <th scope="col">{tOr('Quotes.colNumber', 'Number')}</th>
                  <th scope="col">{tOr('Quotes.colTitle', 'Title')}</th>
                  <th scope="col">{tOr('Quotes.colClient', 'Client')}</th>
                  <th scope="col">{tOr('Quotes.colValidUntil', 'Valid until')}</th>
                  <th scope="col" className="tm-fin-num">
                    {tOr('Quotes.colTotal', 'Total')}
                  </th>
                  <th scope="col">{tOr('Quotes.colState', 'State')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="tm-mono">
                      <Link href={`/${organizationSlug}/quotes/${encodeURIComponent(row.id)}`}>
                        {row.number}
                      </Link>
                    </td>
                    <td>{row.title}</td>
                    <td>
                      {(row.clientOrganizationId === null
                        ? null
                        : clientNames.get(row.clientOrganizationId)) ??
                        row.leadName ??
                        '—'}
                    </td>
                    <td>{day(row.validUntil)}</td>
                    <td className="tm-mono tm-fin-num">{money(row.totalMinor, row.currency)}</td>
                    <td>
                      <StateCapsule state={quoteCapsule(row.status)}>
                        {tOr(...STATUS_WORDS[row.status])}
                      </StateCapsule>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
