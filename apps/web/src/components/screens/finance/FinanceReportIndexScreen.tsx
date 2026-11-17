'use client';

import Link from 'next/link';
import { useContext, type ReactNode } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { AppShell } from '../../shell/AppShell';
import { FeatureOn } from '../../shell/FeatureOn';
import type { OptionalModuleFlag } from '../../../lib/api/admin-feature-flags';
import { browserApiClient } from '../../../lib/api/browser-client';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { useFinanceMe } from './FinanceCoreNav';
import { FinanceReportSectionTabs } from './FinanceReportSectionTabs';
import '../../../styles/screens/finance-ledger.css';

const AREAS: readonly {
  /** Route below the organization, e.g. `/finance/profile`. */
  path: string;
  /** 52-24: the rollout flag that gates this area on the server; none for the finance profile. */
  flag?: OptionalModuleFlag;
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
    flag: 'finance_rates_budgets',
    title: ['FinanceIndex.ratesTitle', 'Rate cards'],
    body: ['FinanceIndex.ratesBody', 'What an hour costs and what it is billed at.'],
  },
  {
    path: '/finance/timesheets',
    flag: 'time_tracking',
    title: ['FinanceIndex.timesheetsTitle', 'Timesheets'],
    body: ['FinanceIndex.timesheetsBody', 'Submit the week and approve the team’s time.'],
  },
  {
    path: '/finance/expenses',
    flag: 'expenses',
    title: ['FinanceIndex.expensesTitle', 'Expenses'],
    body: ['FinanceIndex.expensesBody', 'Submit receipts and approve what others spent.'],
  },
  {
    path: '/finance/retainers',
    flag: 'finance_rates_budgets',
    title: ['FinanceIndex.retainersTitle', 'Retainers'],
    body: ['FinanceIndex.retainersBody', 'Hours each client buys per period, and what is used.'],
  },
  {
    path: '/finance/invoices',
    flag: 'client_invoicing',
    title: ['FinanceIndex.invoicesTitle', 'Invoices'],
    body: ['FinanceIndex.invoicesBody', 'Client invoices, what is paid and what is overdue.'],
  },
  {
    path: '/quotes',
    flag: 'quotes',
    title: ['Quotes.title', 'Quotes'],
    body: ['FinanceIndex.quotesBody', 'Price the work and send it for the client to accept.'],
  },
  {
    path: '/finance/period-locks',
    flag: 'time_tracking',
    title: ['FinanceIndex.periodLocksTitle', 'Period locks'],
    body: ['FinanceIndex.periodLocksBody', 'Close a month so its numbers stay as they are.'],
  },
  {
    path: '/finance/reports',
    flag: 'finance_reports',
    title: ['FinanceIndex.reportsTitle', 'Reports'],
    body: ['FinanceIndex.reportsBody', 'Receivables aging and accounting exports.'],
  },
];

type Area = (typeof AREAS)[number];

function FinanceAreaCard({
  organizationSlug,
  area,
  children,
}: {
  organizationSlug: string;
  area: Area;
  children?: ReactNode;
}) {
  const tOr = useTOr();
  return (
    <>
      <li>
        <Link href={`/${organizationSlug}${area.path}`}>
          <span className="tm-fin-card-title">{tOr(...area.title)}</span>
          <span className="tm-fin-muted">{tOr(...area.body)}</span>
        </Link>
      </li>
      {children}
    </>
  );
}

/**
 * Live check item 5: Team time next to Timesheets, only for holders of "View team time" (the API
 * checks it again). Without a query client (static previews) there is nothing to read, so no card.
 */
function TeamTimeCard({ organizationSlug }: { organizationSlug: string }) {
  const queryClient = useContext(QueryClientContext);
  return queryClient ? <TeamTimeCardFor organizationSlug={organizationSlug} /> : null;
}

function TeamTimeCardFor({ organizationSlug }: { organizationSlug: string }) {
  const tOr = useTOr();
  const { can } = useFinanceMe(browserApiClient(), organizationSlug);
  if (!can('time.view_team')) return null;
  return (
    <li>
      <Link href={`/${organizationSlug}/finance/team-time`}>
        <span className="tm-fin-card-title">{tOr('FinanceCore.tabTeamTime', 'Team time')}</span>
        <span className="tm-fin-muted">
          {tOr(
            'FinanceIndex.teamTimeBody',
            'Who is tracking now, and each person’s time today and this week.',
          )}
        </span>
      </Link>
    </li>
  );
}

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
          {AREAS.map((area) => {
            const card = (
              <FinanceAreaCard key={area.path} organizationSlug={organizationSlug} area={area}>
                {area.path === '/finance/timesheets' ? (
                  <TeamTimeCard organizationSlug={organizationSlug} />
                ) : null}
              </FinanceAreaCard>
            );
            return area.flag ? (
              <FeatureOn key={area.path} organizationSlug={organizationSlug} flag={area.flag}>
                {card}
              </FeatureOn>
            ) : (
              card
            );
          })}
        </ul>
      </div>
    </AppShell>
  );
}
