'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineAlert, SearchField } from '@tmanage/ui';
import { describe, formatMoment, Loading, PlatformGate, ReasonAction } from './shared/platform-kit';
import type { ScreenProps } from './shared/platform-kit';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import {
  fetchPlatformCompany,
  listPlatformCompanies,
  setPlatformCompanySuspended,
} from '../../lib/api/platform-admin';
import type { PlatformCompanyView } from '../../lib/api/platform-admin';

// ── Companies ───────────────────────────────────────────────────────────────

export function PlatformCompaniesScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[t('PlatformAdminScreens.companiesCrumb')]}
      title={t('PlatformAdminScreens.companiesTitle')}
      description={t('PlatformAdminScreens.companiesDescription')}
    >
      {() => <CompaniesBody api={api} />}
    </PlatformGate>
  );
}

function CompaniesBody({ api }: { api: ApiClient }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const companies = useQuery({
    queryKey: ['platform', 'companies', search],
    queryFn: () => listPlatformCompanies(api, search),
  });
  return (
    <>
      <SearchField
        label={t('PlatformAdminScreens.findCompany')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {companies.isPending ? <Loading label={t('PlatformAdminScreens.loadingCompanies')} /> : null}
      {companies.isError ? (
        <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadCompanies')} live>
          {describe(companies.error, t)}
        </InlineAlert>
      ) : null}
      {companies.isSuccess && companies.data.length === 0 ? (
        <InlineAlert tone="neutral">{t('PlatformAdminScreens.noCompanyMatches')}</InlineAlert>
      ) : null}
      {companies.isSuccess && companies.data.length > 0 ? (
        <section
          className="tm-cc-card tm-cc-card--flush"
          aria-label={t('PlatformAdminScreens.companiesTitle')}
        >
          <table
            className="tm-table tm-cc-table"
            aria-label={t('PlatformAdminScreens.companiesTableLabel')}
          >
            <thead>
              <tr>
                <th scope="col">
                  {t('PlatformAdminScreens.companiesTitle')} · {companies.data.length}
                </th>
                <th scope="col">{t('PlatformAdminScreens.colOwner')}</th>
                <th scope="col">{t('PlatformAdminScreens.colPeople')}</th>
                <th scope="col">{t('PlatformAdminScreens.colClients')}</th>
                <th scope="col">{t('PlatformAdminScreens.colProjects')}</th>
                <th scope="col">{t('PlatformAdminScreens.colPlan')}</th>
                <th scope="col">{t('PlatformAdminScreens.colCreated')}</th>
                <th scope="col">{t('PlatformAdminScreens.colLastActive')}</th>
              </tr>
            </thead>
            <tbody>
              {companies.data.map((company) => (
                <tr key={company.id}>
                  <td>
                    <Link href={`/platform/companies/${company.id}`} className="tm-cc-cell-title">
                      {company.name}
                    </Link>
                    <span className="tm-cc-cell-sub">
                      {company.slug}
                      {company.status === 'active' ? '' : ` · ${company.status}`}
                    </span>
                  </td>
                  <td>
                    <span className="tm-cc-cell-sub">{company.ownerEmail ?? '—'}</span>
                  </td>
                  <td className="tm-cc-cell-mono">{company.people}</td>
                  <td className="tm-cc-cell-mono">{company.clients}</td>
                  <td className="tm-cc-cell-mono">{company.projects}</td>
                  <td>
                    <span className="tm-cc-cell-sub">{company.plan ?? '—'}</span>
                  </td>
                  <td>
                    <span className="tm-cc-cell-sub">{formatMoment(company.createdAt)}</span>
                  </td>
                  <td>
                    <span className="tm-cc-cell-sub">{formatMoment(company.lastActiveAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </>
  );
}

export function PlatformCompanyScreen({
  organizationId,
  client,
}: ScreenProps & { organizationId: string }) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="organizations"
      crumbs={[t('PlatformAdminScreens.companiesCrumb'), t('PlatformAdminScreens.companyCrumb')]}
      title={t('PlatformAdminScreens.companyTitle')}
    >
      {() => <CompanyBody api={api} organizationId={organizationId} />}
    </PlatformGate>
  );
}

function CompanyBody({ api, organizationId }: { api: ApiClient; organizationId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['platform', 'company', organizationId],
    queryFn: () => fetchPlatformCompany(api, organizationId),
  });
  if (detail.isPending) return <Loading label={t('PlatformAdminScreens.loadingCompany')} />;
  if (detail.isError) {
    return (
      <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadCompany')} live>
        {describe(detail.error, t)}
      </InlineAlert>
    );
  }
  const company = detail.data.company;
  const suspended = company.status === 'suspended';
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['platform', 'company', organizationId] });

  return (
    <>
      <section className="tm-cc-card" aria-labelledby="tm-platform-company-heading">
        <div className="tm-cc-card__head">
          <h2 id="tm-platform-company-heading" className="tm-cc-card__title">
            {company.name}
          </h2>
          <ReasonAction
            label={
              suspended
                ? t('PlatformAdminScreens.reactivateCompany')
                : t('PlatformAdminScreens.suspendCompany')
            }
            confirmLabel={
              suspended ? t('PlatformAdminScreens.reactivate') : t('PlatformAdminScreens.suspend')
            }
            tone={suspended ? 'outline' : 'destructive'}
            onConfirm={async (reason) => {
              await setPlatformCompanySuspended(api, organizationId, !suspended, reason);
              await refresh();
            }}
          />
        </div>
        {suspended ? (
          <InlineAlert tone="warning" title={t('PlatformAdminScreens.suspendedTitle')}>
            {t('PlatformAdminScreens.suspendedBody')} {formatMoment(company.suspendedAt)}.
          </InlineAlert>
        ) : null}
        <CompanyFacts company={company} />
      </section>

      <section className="tm-cc-card" aria-labelledby="tm-platform-company-audit-heading">
        <div className="tm-cc-card__head">
          <h2 id="tm-platform-company-audit-heading" className="tm-cc-card__title">
            {t('PlatformAdminScreens.recentEvents')}
          </h2>
        </div>
        {detail.data.recentAdminEvents.length === 0 ? (
          <p className="tm-cc-note">{t('PlatformAdminScreens.noEventsYet')}</p>
        ) : (
          <ul className="tm-cc-recent" aria-label={t('PlatformAdminScreens.recentEvents')}>
            {detail.data.recentAdminEvents.map((event) => (
              <li key={event.id}>
                <span className="tm-cc-recent__when">{formatMoment(event.occurredAt)}</span>
                <span>
                  {event.action} · {event.objectType} · {event.result}
                </span>
                <span className="tm-cc-recent__mark" aria-hidden="true" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CompanyFacts({ company }: { company: PlatformCompanyView }) {
  const t = useT();
  const facts: readonly [string, string][] = [
    [t('PlatformAdminScreens.factAddress'), company.slug],
    [t('PlatformAdminScreens.factOwner'), company.ownerEmail ?? '—'],
    [t('PlatformAdminScreens.factPeople'), String(company.people)],
    [t('PlatformAdminScreens.factClients'), String(company.clients)],
    [t('PlatformAdminScreens.factProjects'), String(company.projects)],
    [t('PlatformAdminScreens.factPlan'), company.plan ?? '—'],
    [t('PlatformAdminScreens.factCreated'), formatMoment(company.createdAt)],
    [t('PlatformAdminScreens.factLastActive'), formatMoment(company.lastActiveAt)],
    [t('PlatformAdminScreens.factStatus'), company.status],
  ];
  return (
    <table className="tm-table tm-cc-table" aria-label={t('PlatformAdminScreens.companyDetails')}>
      <tbody>
        {facts.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>
              <span className="tm-cc-cell-sub">{value}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
