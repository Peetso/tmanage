'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { listFinanceExports } from './FinanceReportApi';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import { getInvoiceAging } from './InvoiceApi';
import type { AgingBucketKey } from './InvoiceApi';
import { AGING_WORDS } from './InvoiceRules';
import '../../../styles/screens/finance-ledger.css';

export interface FinanceReportScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const BUCKETS: readonly AgingBucketKey[] = ['0_30', '31_60', '61_90', '90_plus'];

/** Brand names stay Latin in both languages; only the generic file is translated. */
const TARGET_NAMES: Record<string, string> = {
  zoho_books: 'Zoho Books',
  odoo: 'Odoo',
  qoyod: 'Qoyod',
  wafeq: 'Wafeq',
  quickbooks: 'QuickBooks',
  xero: 'Xero',
};

/**
 * **Finance reports** — receivables aging per currency (`GET …/client-invoices/aging`) and the
 * accounting-export history (`GET …/finance/exports`), both `finance.view` (A10b). Amounts in
 * different currencies are never added together: one row per currency.
 */
export function FinanceReportScreen({
  organizationSlug,
  organizationName,
  client,
}: FinanceReportScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { money, day } = useDisplayFormatters();

  const aging = useQuery({
    queryKey: ['client-invoices-aging', organizationSlug],
    queryFn: () => getInvoiceAging(api, organizationSlug),
  });
  const exports = useQuery({
    queryKey: ['finance-exports', organizationSlug],
    queryFn: () => listFinanceExports(api, organizationSlug),
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('FinanceIndex.eyebrow', 'Finance')}
      title={tOr('FinanceReport.title', 'Finance reports')}
      titleMeta={
        aging.data ? `${tOr('FinanceReport.asOf', 'As of')} ${day(aging.data.asOf)}` : undefined
      }
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="reports" />

        <section className="tm-stack tm-stack--tight" aria-labelledby="tm-fin-aging-report">
          <h2 id="tm-fin-aging-report" className="tm-section-title">
            {tOr('FinanceReport.agingTitle', 'Aging')}
          </h2>
          <p className="tm-fin-muted">
            {tOr('FinanceReport.agingSub', 'Open amounts by days past due')}
          </p>
          {aging.isPending ? (
            <LoadingRegion
              label={tOr('FinanceReport.loading', 'Loading the report')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}
          {aging.isError ? (
            <InlineAlert
              tone="danger"
              title={tOr('FinanceReport.errorTitle', 'The report could not load')}
              live
            >
              {describe(aging.error)}
            </InlineAlert>
          ) : null}
          {aging.data && aging.data.currencies.length === 0 ? (
            <InlineAlert tone="neutral">
              {tOr('FinanceReport.agingNone', 'Nothing is past due.')}
            </InlineAlert>
          ) : null}
          {aging.data && aging.data.currencies.length > 0 ? (
            <div className="tm-fin-table-card">
              <table className="tm-table">
                <thead>
                  <tr>
                    <th scope="col">{tOr('FinanceReport.colCurrency', 'Currency')}</th>
                    {BUCKETS.map((bucket) => (
                      <th key={bucket} scope="col" className="tm-fin-num">
                        {tOr(...AGING_WORDS[bucket])}
                      </th>
                    ))}
                    <th scope="col" className="tm-fin-num">
                      {tOr('FinanceReport.colTotal', 'Total')}
                    </th>
                    <th scope="col" className="tm-fin-num">
                      {tOr('FinanceReport.colInvoices', 'Invoices')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aging.data.currencies.map((entry) => (
                    <tr key={entry.currency}>
                      <th scope="row" className="tm-mono">
                        {entry.currency}
                      </th>
                      {BUCKETS.map((bucket) => (
                        <td key={bucket} className="tm-mono tm-fin-num">
                          {money(entry.buckets[bucket], entry.currency)}
                        </td>
                      ))}
                      <td className="tm-mono tm-fin-num">
                        {money(entry.totalMinor, entry.currency)}
                      </td>
                      <td className="tm-mono tm-fin-num">{entry.invoiceCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="tm-stack tm-stack--tight" aria-labelledby="tm-fin-exports-report">
          <h2 id="tm-fin-exports-report" className="tm-section-title">
            {tOr('FinanceReport.exportsTitle', 'Accounting exports')}
          </h2>
          {exports.isError ? (
            <InlineAlert tone="danger" live>
              {describe(exports.error)}
            </InlineAlert>
          ) : null}
          {exports.data && exports.data.length === 0 ? (
            <InlineAlert tone="neutral">
              {tOr('FinanceReport.exportsNone', 'No export has been made yet.')}
            </InlineAlert>
          ) : null}
          {exports.data && exports.data.length > 0 ? (
            <div className="tm-fin-table-card">
              <table className="tm-table">
                <thead>
                  <tr>
                    <th scope="col">{tOr('FinanceReport.colMade', 'Made')}</th>
                    <th scope="col">{tOr('FinanceReport.colPeriod', 'Period')}</th>
                    <th scope="col">{tOr('FinanceReport.colTarget', 'Format')}</th>
                    <th scope="col" className="tm-fin-num">
                      {tOr('FinanceReport.colRows', 'Rows')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exports.data.map((row) => (
                    <tr key={row.id}>
                      <td>{day(row.createdAt)}</td>
                      <td>
                        {day(row.periodStart)} – {day(row.periodEnd)}
                      </td>
                      <td>
                        {TARGET_NAMES[row.target] ??
                          tOr('FinanceReport.targetGeneric', 'Spreadsheet file')}
                      </td>
                      <td className="tm-mono tm-fin-num">
                        {Object.values(row.rowCounts).reduce((sum, count) => sum + count, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
