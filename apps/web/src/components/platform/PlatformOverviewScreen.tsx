'use client';

import { useQuery } from '@tanstack/react-query';
import { InlineAlert } from '@tmanage/ui';
import { describe, formatMoment, formatBytes, Loading, PlatformGate } from './shared/platform-kit';
import type { ScreenProps } from './shared/platform-kit';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import { fetchPlatformOverview } from '../../lib/api/platform-admin';

// ── Overview ────────────────────────────────────────────────────────────────

export function PlatformOverviewScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="overview"
      crumbs={[t('PlatformAdminScreens.overviewCrumb')]}
      title={t('PlatformAdminScreens.overviewTitle')}
    >
      {() => <OverviewBody api={api} />}
    </PlatformGate>
  );
}

function OverviewBody({ api }: { api: ApiClient }) {
  const t = useT();
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () => fetchPlatformOverview(api),
  });
  if (overview.isPending) return <Loading label={t('PlatformAdminScreens.loadingOverview')} />;
  if (overview.isError) {
    return (
      <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadOverview')} live>
        {describe(overview.error, t)}
      </InlineAlert>
    );
  }
  const data = overview.data;
  const problems = data.failedAutomationRuns7d + data.outboxErrors;
  const metrics: readonly { id: string; value: string; label: string; source: string }[] = [
    {
      id: 'companies',
      value: String(data.companies),
      label: t('PlatformAdminScreens.metricCompanies'),
      source: t('PlatformAdminScreens.sourceOrganizations'),
    },
    {
      id: 'people',
      value: String(data.people),
      label: t('PlatformAdminScreens.metricPeople'),
      source: t('PlatformAdminScreens.sourceMemberships'),
    },
    {
      id: 'signups7',
      value: String(data.signups7d),
      label: t('PlatformAdminScreens.metricSignups7'),
      source: t('PlatformAdminScreens.sourceSignups'),
    },
    {
      id: 'signups30',
      value: String(data.signups30d),
      label: t('PlatformAdminScreens.metricSignups30'),
      source: t('PlatformAdminScreens.sourceSignups'),
    },
    {
      id: 'active',
      value: String(data.activeToday),
      label: t('PlatformAdminScreens.metricActive'),
      source: t('PlatformAdminScreens.sourceSessions'),
    },
    {
      id: 'storage',
      value: formatBytes(data.storageBytesUsed),
      label: t('PlatformAdminScreens.metricStorage'),
      source: t('PlatformAdminScreens.sourceFiles'),
    },
  ];
  return (
    <section className="tm-cc-column" aria-labelledby="tm-platform-overview-heading">
      <h2 id="tm-platform-overview-heading" className="tm-visually-hidden">
        {t('PlatformAdminScreens.serviceHealth')}
      </h2>
      <div className="tm-cc-card tm-cc-card--ink tm-cc-hero">
        <div className="tm-stack tm-stack--tight">
          <p className="tm-cc-eyebrow">
            <span className="tm-cc-orb" aria-hidden="true" />
            {problems > 0 ? t('PlatformAdminScreens.actFirst') : t('PlatformAdminScreens.allClear')}
          </p>
          <p className="tm-cc-card__lead">
            {problems > 0
              ? `${data.failedAutomationRuns7d} ${t('PlatformAdminScreens.failedRuns7d')} · ${data.outboxErrors} ${t('PlatformAdminScreens.eventsWaiting')}`
              : t('PlatformAdminScreens.clearLead')}
          </p>
          <p className="tm-cc-card__body">
            {data.suspendedCompanies > 0
              ? `${data.suspendedCompanies} ${data.suspendedCompanies === 1 ? t('PlatformAdminScreens.suspendedCompanyIs') : t('PlatformAdminScreens.suspendedCompaniesAre')} ${t('PlatformAdminScreens.suspendedWord')} `
              : ''}
            {t('PlatformAdminScreens.computedPrefix')} {formatMoment(data.computedAt)}{' '}
            {t('PlatformAdminScreens.computedSuffix')}
          </p>
        </div>
      </div>
      <ul className="tm-cc-metrics" aria-label={t('PlatformAdminScreens.serviceHealth')}>
        {metrics.map((metric) => (
          <li className="tm-cc-metric" key={metric.id}>
            <p className="tm-cc-metric__value">{metric.value}</p>
            <p className="tm-cc-metric__label">{metric.label}</p>
            <p className="tm-cc-metric__source">
              {t('PlatformAdminScreens.sourceWord')} · {metric.source}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
