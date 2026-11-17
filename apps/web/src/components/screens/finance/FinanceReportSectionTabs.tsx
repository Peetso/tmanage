'use client';

import Link from 'next/link';
import type { OptionalModuleFlag } from '../../../lib/api/admin-feature-flags';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { FeatureOn } from '../../shell/FeatureOn';
import '../../../styles/screens/finance-ledger.css';

export type FinanceLedgerSection =
  'overview' | 'retainers' | 'invoices' | 'period-locks' | 'reports';

const SECTIONS: readonly {
  id: FinanceLedgerSection;
  key: string;
  english: string;
  suffix: string;
  /** 52-24: the rollout flag that gates this section on the server. */
  flag?: OptionalModuleFlag;
}[] = [
  { id: 'overview', key: 'FinanceTabs.overview', english: 'Overview', suffix: '' },
  {
    id: 'retainers',
    key: 'FinanceTabs.retainers',
    english: 'Retainers',
    suffix: '/retainers',
    flag: 'finance_rates_budgets',
  },
  {
    id: 'invoices',
    key: 'FinanceTabs.invoices',
    english: 'Invoices',
    suffix: '/invoices',
    flag: 'client_invoicing',
  },
  {
    id: 'period-locks',
    key: 'FinanceTabs.periodLocks',
    english: 'Period locks',
    suffix: '/period-locks',
    flag: 'time_tracking',
  },
  {
    id: 'reports',
    key: 'FinanceTabs.reports',
    english: 'Reports',
    suffix: '/reports',
    flag: 'finance_reports',
  },
];

/**
 * The tab row under the finance headline (R31 L02 Figma section): Overview · Retainers · Invoices ·
 * Period locks · Reports. Each tab is a real route; the current one carries `aria-current="page"`.
 */
export function FinanceReportSectionTabs({
  organizationSlug,
  current,
}: {
  organizationSlug: string;
  current: FinanceLedgerSection;
}) {
  const tOr = useTOr();
  return (
    <nav className="tm-fin-tabs" aria-label={tOr('FinanceTabs.label', 'Finance sections')}>
      <ul className="tm-fin-tabs__list">
        {SECTIONS.map((section) => {
          const tab = (
            <li key={section.id}>
              <Link
                href={`/${organizationSlug}/finance${section.suffix}`}
                className="tm-fin-tabs__link"
                {...(section.id === current ? { 'aria-current': 'page' as const } : {})}
              >
                {tOr(section.key, section.english)}
              </Link>
            </li>
          );
          return section.flag ? (
            <FeatureOn key={section.id} organizationSlug={organizationSlug} flag={section.flag}>
              {tab}
            </FeatureOn>
          ) : (
            tab
          );
        })}
      </ul>
    </nav>
  );
}
