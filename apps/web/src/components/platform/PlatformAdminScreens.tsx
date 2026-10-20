'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { PlatformShell } from './PlatformShell';
import type { PlatformSection } from './PlatformShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import {
  fetchPlatformCompany,
  fetchPlatformMe,
  fetchPlatformOverview,
  fetchPlatformSettings,
  listPlatformAudit,
  listPlatformCompanies,
  searchPlatformPeople,
  sendPlatformPasswordReset,
  setPlatformCompanySuspended,
  setPlatformPublicSignup,
  signOutPlatformPerson,
  stepUpPlatform,
} from '../../lib/api/platform-admin';
import type {
  PlatformCompanyView,
  PlatformMeView,
  PlatformPersonView,
} from '../../lib/api/platform-admin';

/**
 * Platform admin screens (`/platform`) — the TManage operator's view of the whole service.
 *
 * Built only from the Control Center's layout, cards, metric tiles and tables and the design
 * system's controls; the Figma pass comes later. Three rules hold on every screen:
 *
 * 1. **The API decides.** A person not on the server's list gets a 404 from `me`, and the
 *    screen says "not found" — it never guesses who is an operator.
 * 2. **Fresh confirmation.** Until the password (and two-step code) has been confirmed in the
 *    last 15 minutes, the step-up form is all that renders. A lapsed confirmation mid-action
 *    comes back as 403 `reauthentication_required`, which re-opens the form.
 * 3. **Every action asks why.** Suspend, reactivate, sign out, password reset and the sign-up
 *    switch each need a typed reason, which lands in the platform audit log.
 */

export const PLATFORM_ME_KEY = ['platform', 'me'] as const;

interface ScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

function describe(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('PlatformAdminScreens.apiNoAnswer');
  return t('PlatformAdminScreens.genericError');
}

function isStepUpLapse(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'reauthentication_required';
}

function formatMoment(iso: string | null): string {
  if (iso === null) return '—';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)} ${UNITS[unit]}`;
}

function Loading({ label }: { label: string }) {
  return (
    <LoadingRegion label={label} className="tm-stack tm-stack--tight">
      <Skeleton height="var(--row)" />
      <Skeleton height="var(--row)" />
    </LoadingRegion>
  );
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Reads `me`, then either refuses (404), asks for the step-up, or renders the screen. The
 * two-step banner shows for an operator without two-step sign-in on every screen.
 */
function PlatformGate({
  api,
  section,
  crumbs,
  title,
  description,
  children,
}: {
  api: ApiClient;
  section: PlatformSection;
  crumbs: readonly string[];
  title: string;
  description?: ReactNode;
  children: (me: PlatformMeView) => ReactNode;
}) {
  const t = useT();
  const me = useQuery({
    queryKey: PLATFORM_ME_KEY,
    queryFn: () => fetchPlatformMe(api),
    retry: false,
    // A lapsed confirmation re-opens the step-up form on its own, within a minute.
    refetchInterval: 60_000,
  });

  if (me.isError && me.error instanceof ApiRequestError && me.error.status === 404) {
    return (
      <PlatformShell
        section={section}
        crumbs={[t('PlatformAdminScreens.notFound')]}
        title={t('PlatformAdminScreens.pageNotFound')}
      >
        <InlineAlert tone="neutral" title={t('PlatformAdminScreens.pageDoesNotExist')}>
          <Link href="/organizations">{t('PlatformAdminScreens.backToOrganizations')}</Link>
        </InlineAlert>
      </PlatformShell>
    );
  }

  return (
    <PlatformShell
      section={section}
      crumbs={crumbs}
      title={title}
      {...(description ? { description } : {})}
    >
      {me.isPending ? <Loading label={t('PlatformAdminScreens.checkingAccess')} /> : null}
      {me.isError ? (
        <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotOpen')} live>
          {describe(me.error, t)}
        </InlineAlert>
      ) : null}
      {me.isSuccess && !me.data.mfaEnabled ? (
        <InlineAlert tone="warning" title={t('PlatformAdminScreens.setupTwoStepTitle')}>
          {t('PlatformAdminScreens.twoStepBody1')} {me.data.stepUpMinutes}{' '}
          {t('PlatformAdminScreens.twoStepBody2')}{' '}
          <Link href="/organizations">{t('PlatformAdminScreens.yourOrganizations')}</Link>.
        </InlineAlert>
      ) : null}
      {me.isSuccess && me.data.stepUpExpiresAt === null ? (
        <StepUpForm api={api} me={me.data} />
      ) : null}
      {me.isSuccess && me.data.stepUpExpiresAt !== null ? children(me.data) : null}
    </PlatformShell>
  );
}

function StepUpForm({ api, me }: { api: ApiClient; me: PlatformMeView }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: () => stepUpPlatform(api, me.mfaEnabled ? { password, code } : { password }),
    onSuccess: async () => {
      setPassword('');
      setCode('');
      await queryClient.invalidateQueries({ queryKey: ['platform'] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    confirm.mutate();
  }

  return (
    <section className="tm-cc-card" aria-labelledby="tm-platform-step-up-heading">
      <div className="tm-cc-card__head">
        <h2 id="tm-platform-step-up-heading" className="tm-cc-card__title">
          {t('PlatformAdminScreens.confirmItIsYou')}
        </h2>
      </div>
      <p className="tm-cc-note">
        {t('PlatformAdminScreens.stepUpNote1')}
        {me.mfaEnabled ? ` ${t('PlatformAdminScreens.stepUpAndCode')}` : ''}{' '}
        {t('PlatformAdminScreens.stepUpNote2')} {me.stepUpMinutes}{' '}
        {t('PlatformAdminScreens.stepUpMinutesWord')}
      </p>
      <form className="tm-stack tm-stack--tight" onSubmit={submit}>
        <Field
          label={t('PlatformAdminScreens.passwordLabel')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {me.mfaEnabled ? (
          <Field
            label={t('PlatformAdminScreens.twoStepCodeLabel')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        ) : null}
        {confirm.isError ? (
          <InlineAlert tone="danger" title={t('PlatformAdminScreens.notConfirmed')} live>
            {describe(confirm.error, t)}
          </InlineAlert>
        ) : null}
        <div>
          <Button
            type="submit"
            tone="ink"
            loading={confirm.isPending}
            loadingLabel={t('PlatformAdminScreens.confirming')}
          >
            {t('PlatformAdminScreens.continue')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * The reason box every action opens. The action runs only once a reason is typed; a lapsed
 * confirmation re-opens the step-up form through the `me` query.
 */
function ReasonAction({
  label,
  confirmLabel,
  tone = 'outline',
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  tone?: 'outline' | 'destructive' | 'ink';
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const action = useMutation({
    mutationFn: () => onConfirm(reason.trim()),
    onSuccess: () => {
      setOpen(false);
      setReason('');
    },
    onError: async (error) => {
      if (isStepUpLapse(error)) await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_KEY });
    },
  });

  if (!open) {
    return (
      <Button type="button" tone={tone} size="compact" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }

  return (
    <form
      className="tm-stack tm-stack--tight"
      onSubmit={(event) => {
        event.preventDefault();
        action.mutate();
      }}
    >
      <Field
        label={`${t('PlatformAdminScreens.reasonFor')} “${label}”`}
        hint={t('PlatformAdminScreens.reasonHint')}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        minLength={5}
        maxLength={500}
        required
      />
      {action.isError ? (
        <InlineAlert tone="danger" title={t('PlatformAdminScreens.notDone')} live>
          {describe(action.error, t)}
        </InlineAlert>
      ) : null}
      <div className="tm-cc-hero__actions">
        <Button
          type="submit"
          tone={tone === 'outline' ? 'ink' : tone}
          size="compact"
          loading={action.isPending}
          loadingLabel={t('PlatformAdminScreens.working')}
          disabled={reason.trim().length < 5}
        >
          {confirmLabel}
        </Button>
        <Button type="button" tone="text" size="compact" onClick={() => setOpen(false)}>
          {t('PlatformAdminScreens.cancel')}
        </Button>
      </div>
    </form>
  );
}

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

// ── Companies ───────────────────────────────────────────────────────────────

export function PlatformCompaniesScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="companies"
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
      section="companies"
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

// ── People ──────────────────────────────────────────────────────────────────

export function PlatformPeopleScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="people"
      crumbs={[t('PlatformAdminScreens.peopleCrumb')]}
      title={t('PlatformAdminScreens.peopleTitle')}
      description={t('PlatformAdminScreens.peopleDescription')}
    >
      {() => <PeopleBody api={api} />}
    </PlatformGate>
  );
}

function PeopleBody({ api }: { api: ApiClient }) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const [email, setEmail] = useState('');
  const people = useQuery({
    queryKey: ['platform', 'people', email],
    queryFn: () => searchPlatformPeople(api, email),
    enabled: email.length >= 3,
  });
  return (
    <>
      <form
        className="tm-stack tm-stack--tight"
        onSubmit={(event) => {
          event.preventDefault();
          setEmail(draft.trim().toLowerCase());
        }}
      >
        <Field
          label={t('PlatformAdminScreens.emailLabel')}
          type="search"
          hint={t('PlatformAdminScreens.emailHint')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div>
          <Button type="submit" tone="ink" size="compact" disabled={draft.trim().length < 3}>
            {t('PlatformAdminScreens.search')}
          </Button>
        </div>
      </form>
      {people.isFetching ? <Loading label={t('PlatformAdminScreens.searchingPeople')} /> : null}
      {people.isError ? (
        <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotSearch')} live>
          {describe(people.error, t)}
        </InlineAlert>
      ) : null}
      {people.isSuccess && people.data.length === 0 ? (
        <InlineAlert tone="neutral">{t('PlatformAdminScreens.nobodyWithEmail')}</InlineAlert>
      ) : null}
      {people.isSuccess
        ? people.data.map((person) => <PersonCard key={person.id} api={api} person={person} />)
        : null}
    </>
  );
}

function PersonCard({ api, person }: { api: ApiClient; person: PlatformPersonView }) {
  const t = useT();
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section className="tm-cc-card" aria-label={person.email}>
      <div className="tm-cc-card__head">
        <h2 className="tm-cc-card__title">{person.email}</h2>
        <div className="tm-cc-hero__actions">
          <ReasonAction
            label={t('PlatformAdminScreens.signOutEverywhere')}
            confirmLabel={t('PlatformAdminScreens.signOut')}
            tone="destructive"
            onConfirm={async (reason) => {
              const result = await signOutPlatformPerson(api, person.id, reason);
              setNotice(`${result.sessionsEnded} ${t('PlatformAdminScreens.sessionsEnded')}`);
            }}
          />
          <ReasonAction
            label={t('PlatformAdminScreens.sendPasswordReset')}
            confirmLabel={t('PlatformAdminScreens.sendEmail')}
            onConfirm={async (reason) => {
              await sendPlatformPasswordReset(api, person.id, reason);
              setNotice(t('PlatformAdminScreens.resetEmailSent'));
            }}
          />
        </div>
      </div>
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}
      <p className="tm-cc-note">
        {person.displayName} · {t('PlatformAdminScreens.lastSignIn')}{' '}
        {formatMoment(person.lastSignInAt)} · {t('PlatformAdminScreens.twoStepWord')}{' '}
        {person.mfaEnabled ? t('PlatformAdminScreens.on') : t('PlatformAdminScreens.off')} ·{' '}
        {t('PlatformAdminScreens.emailWord')}{' '}
        {person.emailVerified
          ? t('PlatformAdminScreens.verified')
          : t('PlatformAdminScreens.notVerified')}
      </p>
      {person.companies.length === 0 ? (
        <p className="tm-cc-note">{t('PlatformAdminScreens.notMemberOfAny')}</p>
      ) : (
        <table
          className="tm-table tm-cc-table"
          aria-label={`${t('PlatformAdminScreens.companiesOf')} ${person.email}`}
        >
          <thead>
            <tr>
              <th scope="col">{t('PlatformAdminScreens.colCompany')}</th>
              <th scope="col">{t('PlatformAdminScreens.colRole')}</th>
              <th scope="col">{t('PlatformAdminScreens.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {person.companies.map((company) => (
              <tr key={`${company.id}-${company.audience}`}>
                <td>
                  <Link href={`/platform/companies/${company.id}`} className="tm-cc-cell-title">
                    {company.name}
                  </Link>
                  <span className="tm-cc-cell-sub">
                    {company.audience === 'client'
                      ? t('PlatformAdminScreens.clientAccess')
                      : t('PlatformAdminScreens.team')}
                  </span>
                </td>
                <td>
                  <span className="tm-cc-cell-sub">{company.role}</span>
                </td>
                <td>
                  <span className="tm-cc-cell-sub">{company.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

export function PlatformSettingsScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="settings"
      crumbs={[t('PlatformAdminScreens.settingsCrumb')]}
      title={t('PlatformAdminScreens.settingsTitle')}
    >
      {() => <SettingsBody api={api} />}
    </PlatformGate>
  );
}

function SettingsBody({ api }: { api: ApiClient }) {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['platform', 'settings'],
    queryFn: () => fetchPlatformSettings(api),
  });
  if (settings.isPending) return <Loading label={t('PlatformAdminScreens.loadingSettings')} />;
  if (settings.isError) {
    return (
      <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadSettings')} live>
        {describe(settings.error, t)}
      </InlineAlert>
    );
  }
  const signup = settings.data.publicSignup;
  return (
    <section className="tm-cc-card" aria-labelledby="tm-platform-signup-heading">
      <div className="tm-cc-card__head">
        <h2 id="tm-platform-signup-heading" className="tm-cc-card__title">
          {t('PlatformAdminScreens.publicSignupIs')}{' '}
          {signup.open ? t('PlatformAdminScreens.open') : t('PlatformAdminScreens.closed')}
        </h2>
        <ReasonAction
          label={
            signup.open
              ? t('PlatformAdminScreens.closeSignup')
              : t('PlatformAdminScreens.openSignup')
          }
          confirmLabel={
            signup.open
              ? t('PlatformAdminScreens.closeConfirm')
              : t('PlatformAdminScreens.openConfirm')
          }
          tone={signup.open ? 'destructive' : 'ink'}
          onConfirm={async (reason) => {
            await setPlatformPublicSignup(api, !signup.open, reason);
            await queryClient.invalidateQueries({ queryKey: ['platform', 'settings'] });
          }}
        />
      </div>
      <p className="tm-cc-note">
        {signup.open
          ? t('PlatformAdminScreens.signupOpenBody')
          : t('PlatformAdminScreens.signupClosedBody')}{' '}
        {signup.source === 'environment'
          ? `${t('PlatformAdminScreens.followingServerSetting')} (${signup.environmentDefault ? t('PlatformAdminScreens.on') : t('PlatformAdminScreens.off')}).`
          : `${t('PlatformAdminScreens.setHereOverrides')} (${signup.environmentDefault ? t('PlatformAdminScreens.on') : t('PlatformAdminScreens.off')}).`}
      </p>
    </section>
  );
}

// ── Audit ───────────────────────────────────────────────────────────────────

export function PlatformAuditScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  return (
    <PlatformGate
      api={api}
      section="audit"
      crumbs={[t('PlatformAdminScreens.auditCrumb')]}
      title={t('PlatformAdminScreens.auditTitle')}
      description={t('PlatformAdminScreens.auditDescription')}
    >
      {() => <AuditBody api={api} />}
    </PlatformGate>
  );
}

function AuditBody({ api }: { api: ApiClient }) {
  const t = useT();
  const events = useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: () => listPlatformAudit(api),
  });
  if (events.isPending) return <Loading label={t('PlatformAdminScreens.loadingAudit')} />;
  if (events.isError) {
    return (
      <InlineAlert tone="danger" title={t('PlatformAdminScreens.couldNotLoadAudit')} live>
        {describe(events.error, t)}
      </InlineAlert>
    );
  }
  if (events.data.length === 0) {
    return <InlineAlert tone="neutral">{t('PlatformAdminScreens.noActionsYet')}</InlineAlert>;
  }
  return (
    <section
      className="tm-cc-card tm-cc-card--flush"
      aria-label={t('PlatformAdminScreens.auditTitle')}
    >
      <table
        className="tm-table tm-cc-table"
        aria-label={t('PlatformAdminScreens.auditTableLabel')}
      >
        <thead>
          <tr>
            <th scope="col">{t('PlatformAdminScreens.colWhen')}</th>
            <th scope="col">{t('PlatformAdminScreens.colWho')}</th>
            <th scope="col">{t('PlatformAdminScreens.colAction')}</th>
            <th scope="col">{t('PlatformAdminScreens.colTarget')}</th>
            <th scope="col">{t('PlatformAdminScreens.colReason')}</th>
          </tr>
        </thead>
        <tbody>
          {events.data.map((event) => (
            <tr key={event.id}>
              <td>
                <span className="tm-cc-cell-sub">{formatMoment(event.occurredAt)}</span>
              </td>
              <td>
                <span className="tm-cc-cell-sub">{event.actorEmail}</span>
              </td>
              <td className="tm-cc-cell-mono">{event.action}</td>
              <td>
                <span className="tm-cc-cell-sub">{event.targetLabel ?? event.targetType}</span>
              </td>
              <td>
                <span className="tm-cc-cell-sub">{event.reason}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
