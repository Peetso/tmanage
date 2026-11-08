'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import { getInvoiceAging, listClientInvoices } from './InvoiceApi';
import type { AgingBucketKey } from './InvoiceApi';
import { AGING_WORDS, INVOICE_FILTERS, invoiceCapsule, invoiceStateKey } from './InvoiceRules';
import type { InvoiceFilter } from './InvoiceRules';
import { InvoiceStateWord, useClientNames } from './InvoiceStateWord';
import '../../../styles/screens/finance-ledger.css';

export interface InvoiceListScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const FILTER_WORDS: Record<InvoiceFilter, readonly [string, string]> = {
  all: ['InvoiceList.filterAll', 'All'],
  draft: ['InvoiceList.filterDraft', 'Draft'],
  sent: ['InvoiceList.filterSent', 'Sent'],
  partially_paid: ['InvoiceList.filterPartiallyPaid', 'Part paid'],
  paid: ['InvoiceList.filterPaid', 'Paid'],
  void: ['InvoiceList.filterVoid', 'Void'],
};

/**
 * **Invoices** — the client invoice list (A10b), drawn as the R31 L02 Figma frame: the finance tabs,
 * the state filters, the invoice table and, beside it, the aging card. Reads
 * `GET …/client-invoices` and `GET …/client-invoices/aging` (both `finance.view`); a caller without
 * it sees the API's refusal as a sentence. "New invoice" opens the editor (R35 L6-52-09).
 */
export function InvoiceListScreen({
  organizationSlug,
  organizationName,
  client,
}: InvoiceListScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();
  const [filter, setFilter] = useState<InvoiceFilter>('all');

  const invoices = useInfiniteQuery({
    queryKey: ['client-invoices', organizationSlug, filter],
    queryFn: ({ pageParam }) =>
      listClientInvoices(api, organizationSlug, {
        state: filter === 'all' ? null : filter,
        cursor: pageParam,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const aging = useQuery({
    queryKey: ['client-invoices-aging', organizationSlug],
    queryFn: () => getInvoiceAging(api, organizationSlug),
  });
  const clientNames = useClientNames(api, organizationSlug);

  const rows = useMemo(
    () => invoices.data?.pages.flatMap((page) => page.invoices) ?? [],
    [invoices.data],
  );
  const overdue = rows.filter((row) => row.overdue).length;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('FinanceIndex.eyebrow', 'Finance')}
      title={tOr('InvoiceList.title', 'Invoices')}
      actions={
        <Link
          className="tm-button tm-button--ink"
          href={`/${organizationSlug}/finance/invoices/new`}
        >
          {tOr('InvoiceList.newInvoice', 'New invoice')}
        </Link>
      }
      titleMeta={
        rows.length > 0
          ? `${rows.length} ${tOr('InvoiceList.countWord', 'invoices')} · ${overdue} ${tOr('InvoiceList.overdueWord', 'overdue')}`
          : undefined
      }
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="invoices" />

        <div
          className="tm-chip-row"
          role="group"
          aria-label={tOr('InvoiceList.filterLabel', 'Filter by state')}
        >
          {INVOICE_FILTERS.map((option) => (
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

        {invoices.isPending ? (
          <LoadingRegion
            label={tOr('InvoiceList.loading', 'Loading invoices')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {invoices.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('InvoiceList.errorTitle', 'Invoices could not load')}
            live
          >
            {describe(invoices.error)}
          </InlineAlert>
        ) : null}

        {invoices.isSuccess && rows.length === 0 ? (
          <div className="tm-card tm-card--empty">
            <InlineAlert tone="neutral" title={tOr('InvoiceList.emptyTitle', 'No invoices yet')}>
              {tOr(
                'InvoiceList.emptyBody',
                'Invoices appear here once they are created from approved time, a retainer period or a fixed fee.',
              )}
            </InlineAlert>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="tm-fin">
            <section aria-labelledby="tm-fin-invoices-heading" className="tm-stack tm-stack--tight">
              <h2 id="tm-fin-invoices-heading" className="tm-visually-hidden">
                {tOr('InvoiceList.title', 'Invoices')}
              </h2>
              <div className="tm-fin-table-card">
                <table className="tm-table">
                  <thead>
                    <tr>
                      <th scope="col">{tOr('InvoiceList.colNumber', 'Number')}</th>
                      <th scope="col">{tOr('InvoiceList.colClient', 'Client')}</th>
                      <th scope="col">{tOr('InvoiceList.colIssued', 'Issued')}</th>
                      <th scope="col">{tOr('InvoiceList.colDue', 'Due')}</th>
                      <th scope="col" className="tm-fin-num">
                        {tOr('InvoiceList.colAmountDue', 'Amount due')}
                      </th>
                      <th scope="col">{tOr('InvoiceList.colState', 'State')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="tm-mono">
                          <Link
                            href={`/${organizationSlug}/finance/invoices/${encodeURIComponent(row.id)}`}
                          >
                            {row.number ?? tOr('InvoiceList.draftNumber', 'Draft')}
                          </Link>
                        </td>
                        <td>{clientNames.get(row.clientOrganizationId) ?? '—'}</td>
                        <td>{row.issueDate ? day(row.issueDate) : '—'}</td>
                        <td>{row.dueDate ? day(row.dueDate) : '—'}</td>
                        <td className="tm-mono tm-fin-num">
                          {money(row.amountDueMinor, row.currency)}
                        </td>
                        <td>
                          <StateCapsule state={invoiceCapsule(row.state, row.overdue)}>
                            <InvoiceStateWord stateKey={invoiceStateKey(row.state, row.overdue)} />
                          </StateCapsule>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {invoices.hasNextPage ? (
                <div className="tm-row">
                  <Button
                    type="button"
                    tone="outline"
                    size="compact"
                    loading={invoices.isFetchingNextPage}
                    loadingLabel={tOr('InvoiceList.loadingMore', 'Loading more invoices')}
                    onClick={() => void invoices.fetchNextPage()}
                  >
                    {tOr('InvoiceList.loadMore', 'Show more')}
                  </Button>
                </div>
              ) : null}
            </section>

            <div className="tm-fin-col">
              <section className="tm-card" aria-labelledby="tm-fin-aging-heading">
                <h2 id="tm-fin-aging-heading" className="tm-fin-card-title">
                  {tOr('FinanceReport.agingTitle', 'Aging')}
                </h2>
                <p className="tm-fin-muted">
                  {tOr('FinanceReport.agingSub', 'Open amounts by days past due')}
                </p>
                {aging.isError ? <p className="tm-fin-muted">{describe(aging.error)}</p> : null}
                {aging.data && aging.data.currencies.length === 0 ? (
                  <p className="tm-fin-muted">
                    {tOr('FinanceReport.agingNone', 'Nothing is past due.')}
                  </p>
                ) : null}
                {aging.data?.currencies.map((entry) => (
                  <dl key={entry.currency} className="tm-fin-buckets">
                    {(Object.keys(AGING_WORDS) as AgingBucketKey[]).map((bucket) => (
                      <div key={bucket}>
                        <dt>{tOr(...AGING_WORDS[bucket])}</dt>
                        <dd>{money(entry.buckets[bucket], entry.currency)}</dd>
                      </div>
                    ))}
                  </dl>
                ))}
                <Link className="tm-chip" href={`/${organizationSlug}/finance/reports`}>
                  {tOr('FinanceTabs.reports', 'Reports')}
                </Link>
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
