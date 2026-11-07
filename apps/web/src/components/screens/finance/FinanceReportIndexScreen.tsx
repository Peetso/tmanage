'use client';

import Link from 'next/link';
import { AppShell } from '../../shell/AppShell';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import '../../../styles/screens/finance-ledger.css';

const AREAS: readonly {
  /** Route below the organization, e.g. `/finance/profile`. */
  path: string;
  title: readonly [string, string];
  body: readonly [string, string];
}[] = [
  {
    path: '/finance/profile',
    title: ['FinanceIndex.profileTitle', 'Finance profile'],
    body: [
      'FinanceIndex.profileBody',
      'Legal name, tax number, base currency and invoice numbering.',
    ],
  },
  {
    path: '/finance/rates',
    title: ['FinanceIndex.ratesTitle', 'Rate cards'],
    body: ['FinanceIndex.ratesBody', 'What an hour costs and what it is billed at.'],
  },
  {
    path: '/finance/timesheets',
    title: ['FinanceIndex.timesheetsTitle', 'Timesheets'],
    body: ['FinanceIndex.timesheetsBody', 'Submit the week and approve the team’s time.'],
  },
  {
    path: '/finance/expenses',
    title: ['FinanceIndex.expensesTitle', 'Expenses'],
    body: ['FinanceIndex.expensesBody', 'Submit receipts and approve what others spent.'],
  },
  {
    path: '/finance/retainers',
    title: ['FinanceIndex.retainersTitle', 'Retainers'],
    body: ['FinanceIndex.retainersBody', 'Hours each client buys per period, and what is used.'],
  },
  {
    path: '/finance/invoices',
    title: ['FinanceIndex.invoicesTitle', 'Invoices'],
    body: ['FinanceIndex.invoicesBody', 'Client invoices, what is paid and what is overdue.'],
  },
  {
    path: '/quotes',
    title: ['Quotes.title', 'Quotes'],
    body: ['FinanceIndex.quotesBody', 'Price the work and send it for the client to accept.'],
  },
  {
    path: '/finance/period-locks',
    title: ['FinanceIndex.periodLocksTitle', 'Period locks'],
    body: ['FinanceIndex.periodLocksBody', 'Close a month so its numbers stay as they are.'],
  },
  {
    path: '/finance/reports',
    title: ['FinanceIndex.reportsTitle', 'Reports'],
    body: ['FinanceIndex.reportsBody', 'Receivables aging and accounting exports.'],
  },
];

/**
 * **Finance** — the finance home (A10b): one card per finance area, each a link to its route. The
 * areas enforce their own capabilities on the API; this page only points the way.
 */
export function FinanceReportIndexScreen({
  organizationSlug,
  organizationName,
}: {
  organizationSlug: string;
  organizationName: string;
}) {
  const tOr = useTOr();
  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tOr('FinanceIndex.eyebrow', 'Finance')}
      title={tOr('FinanceIndex.title', 'Finance')}
      description={tOr(
        'FinanceIndex.description',
        'Rates, time, expenses, retainers and invoices in one place.',
      )}
    >
      <div className="tm-stack">
        <FinanceReportSectionTabs organizationSlug={organizationSlug} current="overview" />
        <ul className="tm-fin-index">
          {AREAS.map((area) => (
            <li key={area.path}>
              <Link href={`/${organizationSlug}${area.path}`}>
                <span className="tm-fin-card-title">{tOr(...area.title)}</span>
                <span className="tm-fin-muted">{tOr(...area.body)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </AppShell>
  );
}
