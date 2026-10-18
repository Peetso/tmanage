'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, SearchField, Skeleton } from '@tmanage/ui';
import { PlatformShell } from './PlatformShell';
import type { PlatformSection } from './PlatformShell';
import { browserApiClient } from '../../lib/api/browser-client';
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

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
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
  const me = useQuery({
    queryKey: PLATFORM_ME_KEY,
    queryFn: () => fetchPlatformMe(api),
    retry: false,
    // A lapsed confirmation re-opens the step-up form on its own, within a minute.
    refetchInterval: 60_000,
  });

  if (me.isError && me.error instanceof ApiRequestError && me.error.status === 404) {
    return (
      <PlatformShell section={section} crumbs={['Not found']} title="Page not found">
        <InlineAlert tone="neutral" title="This page does not exist">
          <Link href="/organizations">Back to your organizations</Link>
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
      {me.isPending ? <Loading label="Checking your access." /> : null}
      {me.isError ? (
        <InlineAlert tone="danger" title="Could not open Platform admin" live>
          {describe(me.error)}
        </InlineAlert>
      ) : null}
      {me.isSuccess && !me.data.mfaEnabled ? (
        <InlineAlert tone="warning" title="Set up two-step sign-in">
          Your account has no two-step sign-in yet, so Platform admin asks for your password every{' '}
          {me.data.stepUpMinutes} minutes. Turn it on from Preferences in any of{' '}
          <Link href="/organizations">your organizations</Link>.
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
          Confirm it is you
        </h2>
      </div>
      <p className="tm-cc-note">
        Platform admin reaches every company on TManage. Confirm your password
        {me.mfaEnabled ? ' and two-step code' : ''} to continue for the next {me.stepUpMinutes}{' '}
        minutes.
      </p>
      <form className="tm-stack tm-stack--tight" onSubmit={submit}>
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {me.mfaEnabled ? (
          <Field
            label="Two-step code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        ) : null}
        {confirm.isError ? (
          <InlineAlert tone="danger" title="Not confirmed" live>
            {describe(confirm.error)}
          </InlineAlert>
        ) : null}
        <div>
          <Button type="submit" tone="ink" loading={confirm.isPending} loadingLabel="Confirming">
            Continue
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
        label={`Reason for “${label}”`}
        hint="Saved in the platform audit log with your name and the time."
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        minLength={5}
        maxLength={500}
        required
      />
      {action.isError ? (
        <InlineAlert tone="danger" title="Not done" live>
          {describe(action.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-cc-hero__actions">
        <Button
          type="submit"
          tone={tone === 'outline' ? 'ink' : tone}
          size="compact"
          loading={action.isPending}
          loadingLabel="Working"
          disabled={reason.trim().length < 5}
        >
          {confirmLabel}
        </Button>
        <Button type="button" tone="text" size="compact" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

export function PlatformOverviewScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  return (
    <PlatformGate api={api} section="overview" crumbs={['Overview']} title="The whole service">
      {() => <OverviewBody api={api} />}
    </PlatformGate>
  );
}

function OverviewBody({ api }: { api: ApiClient }) {
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () => fetchPlatformOverview(api),
  });
  if (overview.isPending) return <Loading label="Loading the platform overview." />;
  if (overview.isError) {
    return (
      <InlineAlert tone="danger" title="Could not load the overview" live>
        {describe(overview.error)}
      </InlineAlert>
    );
  }
  const data = overview.data;
  const problems = data.failedAutomationRuns7d + data.outboxErrors;
  const metrics: readonly { id: string; value: string; label: string; source: string }[] = [
    { id: 'companies', value: String(data.companies), label: 'companies', source: 'Organizations' },
    { id: 'people', value: String(data.people), label: 'people', source: 'Memberships' },
    {
      id: 'signups7',
      value: String(data.signups7d),
      label: 'new companies in 7 days',
      source: 'Sign-ups',
    },
    {
      id: 'signups30',
      value: String(data.signups30d),
      label: 'new companies in 30 days',
      source: 'Sign-ups',
    },
    { id: 'active', value: String(data.activeToday), label: 'active today', source: 'Sessions' },
    {
      id: 'storage',
      value: formatBytes(data.storageBytesUsed),
      label: 'storage used',
      source: 'Files',
    },
  ];
  return (
    <section className="tm-cc-column" aria-labelledby="tm-platform-overview-heading">
      <h2 id="tm-platform-overview-heading" className="tm-visually-hidden">
        Service health
      </h2>
      <div className="tm-cc-card tm-cc-card--ink tm-cc-hero">
        <div className="tm-stack tm-stack--tight">
          <p className="tm-cc-eyebrow">
            <span className="tm-cc-orb" aria-hidden="true" />
            {problems > 0 ? 'Act first' : 'All clear'}
          </p>
          <p className="tm-cc-card__lead">
            {problems > 0
              ? `${data.failedAutomationRuns7d} failed automation runs in 7 days · ${data.outboxErrors} events waiting to retry`
              : 'No failed automation runs this week and no events waiting to retry'}
          </p>
          <p className="tm-cc-card__body">
            {data.suspendedCompanies > 0
              ? `${data.suspendedCompanies} ${data.suspendedCompanies === 1 ? 'company is' : 'companies are'} suspended. `
              : ''}
            Computed {formatMoment(data.computedAt)} from live counts.
          </p>
        </div>
      </div>
      <ul className="tm-cc-metrics" aria-label="Service health">
        {metrics.map((metric) => (
          <li className="tm-cc-metric" key={metric.id}>
            <p className="tm-cc-metric__value">{metric.value}</p>
            <p className="tm-cc-metric__label">{metric.label}</p>
            <p className="tm-cc-metric__source">Source · {metric.source}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Companies ───────────────────────────────────────────────────────────────

export function PlatformCompaniesScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  return (
    <PlatformGate
      api={api}
      section="companies"
      crumbs={['Companies']}
      title="Companies"
      description="Names, counts and dates only — never their work, chats, docs or files."
    >
      {() => <CompaniesBody api={api} />}
    </PlatformGate>
  );
}

function CompaniesBody({ api }: { api: ApiClient }) {
  const [search, setSearch] = useState('');
  const companies = useQuery({
    queryKey: ['platform', 'companies', search],
    queryFn: () => listPlatformCompanies(api, search),
  });
  return (
    <>
      <SearchField
        label="Find a company"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {companies.isPending ? <Loading label="Loading companies." /> : null}
      {companies.isError ? (
        <InlineAlert tone="danger" title="Could not load companies" live>
          {describe(companies.error)}
        </InlineAlert>
      ) : null}
      {companies.isSuccess && companies.data.length === 0 ? (
        <InlineAlert tone="neutral">No company matches.</InlineAlert>
      ) : null}
      {companies.isSuccess && companies.data.length > 0 ? (
        <section className="tm-cc-card tm-cc-card--flush" aria-label="Companies">
          <table className="tm-table tm-cc-table" aria-label="Companies on TManage">
            <thead>
              <tr>
                <th scope="col">Companies · {companies.data.length}</th>
                <th scope="col">Owner</th>
                <th scope="col">People</th>
                <th scope="col">Clients</th>
                <th scope="col">Projects</th>
                <th scope="col">Plan</th>
                <th scope="col">Created</th>
                <th scope="col">Last active</th>
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
  return (
    <PlatformGate api={api} section="companies" crumbs={['Companies', 'Company']} title="Company">
      {() => <CompanyBody api={api} organizationId={organizationId} />}
    </PlatformGate>
  );
}

function CompanyBody({ api, organizationId }: { api: ApiClient; organizationId: string }) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['platform', 'company', organizationId],
    queryFn: () => fetchPlatformCompany(api, organizationId),
  });
  if (detail.isPending) return <Loading label="Loading the company." />;
  if (detail.isError) {
    return (
      <InlineAlert tone="danger" title="Could not load the company" live>
        {describe(detail.error)}
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
            label={suspended ? 'Reactivate company' : 'Suspend company'}
            confirmLabel={suspended ? 'Reactivate' : 'Suspend'}
            tone={suspended ? 'outline' : 'destructive'}
            onConfirm={async (reason) => {
              await setPlatformCompanySuspended(api, organizationId, !suspended, reason);
              await refresh();
            }}
          />
        </div>
        {suspended ? (
          <InlineAlert tone="warning" title="Suspended">
            Members see “workspace suspended, contact support”. Their data is kept. Suspended{' '}
            {formatMoment(company.suspendedAt)}.
          </InlineAlert>
        ) : null}
        <CompanyFacts company={company} />
      </section>

      <section className="tm-cc-card" aria-labelledby="tm-platform-company-audit-heading">
        <div className="tm-cc-card__head">
          <h2 id="tm-platform-company-audit-heading" className="tm-cc-card__title">
            Recent admin and security events
          </h2>
        </div>
        {detail.data.recentAdminEvents.length === 0 ? (
          <p className="tm-cc-note">No admin or security events recorded yet.</p>
        ) : (
          <ul className="tm-cc-recent" aria-label="Recent admin and security events">
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
  const facts: readonly [string, string][] = [
    ['Address', company.slug],
    ['Owner', company.ownerEmail ?? '—'],
    ['People', String(company.people)],
    ['Clients', String(company.clients)],
    ['Projects', String(company.projects)],
    ['Plan', company.plan ?? '—'],
    ['Created', formatMoment(company.createdAt)],
    ['Last active', formatMoment(company.lastActiveAt)],
    ['Status', company.status],
  ];
  return (
    <table className="tm-table tm-cc-table" aria-label="Company details">
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
  return (
    <PlatformGate
      api={api}
      section="people"
      crumbs={['People']}
      title="People"
      description="Search by email. You can end a person’s sessions or send them a password-reset email; you never see or set their password."
    >
      {() => <PeopleBody api={api} />}
    </PlatformGate>
  );
}

function PeopleBody({ api }: { api: ApiClient }) {
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
          label="Email"
          type="search"
          hint="At least three characters."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div>
          <Button type="submit" tone="ink" size="compact" disabled={draft.trim().length < 3}>
            Search
          </Button>
        </div>
      </form>
      {people.isFetching ? <Loading label="Searching people." /> : null}
      {people.isError ? (
        <InlineAlert tone="danger" title="Could not search" live>
          {describe(people.error)}
        </InlineAlert>
      ) : null}
      {people.isSuccess && people.data.length === 0 ? (
        <InlineAlert tone="neutral">Nobody with that email.</InlineAlert>
      ) : null}
      {people.isSuccess
        ? people.data.map((person) => <PersonCard key={person.id} api={api} person={person} />)
        : null}
    </>
  );
}

function PersonCard({ api, person }: { api: ApiClient; person: PlatformPersonView }) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <section className="tm-cc-card" aria-label={person.email}>
      <div className="tm-cc-card__head">
        <h2 className="tm-cc-card__title">{person.email}</h2>
        <div className="tm-cc-hero__actions">
          <ReasonAction
            label="Sign out everywhere"
            confirmLabel="Sign out"
            tone="destructive"
            onConfirm={async (reason) => {
              const result = await signOutPlatformPerson(api, person.id, reason);
              setNotice(`${result.sessionsEnded} sessions ended.`);
            }}
          />
          <ReasonAction
            label="Send password reset"
            confirmLabel="Send email"
            onConfirm={async (reason) => {
              await sendPlatformPasswordReset(api, person.id, reason);
              setNotice('A password-reset email is on its way to them.');
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
        {person.displayName} · last sign-in {formatMoment(person.lastSignInAt)} · two-step{' '}
        {person.mfaEnabled ? 'on' : 'off'} · email{' '}
        {person.emailVerified ? 'verified' : 'not verified'}
      </p>
      {person.companies.length === 0 ? (
        <p className="tm-cc-note">Not a member of any company.</p>
      ) : (
        <table className="tm-table tm-cc-table" aria-label={`Companies of ${person.email}`}>
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
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
                    {company.audience === 'client' ? 'client access' : 'team'}
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
  return (
    <PlatformGate api={api} section="settings" crumbs={['Settings']} title="Settings">
      {() => <SettingsBody api={api} />}
    </PlatformGate>
  );
}

function SettingsBody({ api }: { api: ApiClient }) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ['platform', 'settings'],
    queryFn: () => fetchPlatformSettings(api),
  });
  if (settings.isPending) return <Loading label="Loading settings." />;
  if (settings.isError) {
    return (
      <InlineAlert tone="danger" title="Could not load settings" live>
        {describe(settings.error)}
      </InlineAlert>
    );
  }
  const signup = settings.data.publicSignup;
  return (
    <section className="tm-cc-card" aria-labelledby="tm-platform-signup-heading">
      <div className="tm-cc-card__head">
        <h2 id="tm-platform-signup-heading" className="tm-cc-card__title">
          Public sign-up is {signup.open ? 'open' : 'closed'}
        </h2>
        <ReasonAction
          label={signup.open ? 'Close sign-up' : 'Open sign-up'}
          confirmLabel={signup.open ? 'Close' : 'Open'}
          tone={signup.open ? 'destructive' : 'ink'}
          onConfirm={async (reason) => {
            await setPlatformPublicSignup(api, !signup.open, reason);
            await queryClient.invalidateQueries({ queryKey: ['platform', 'settings'] });
          }}
        />
      </div>
      <p className="tm-cc-note">
        {signup.open
          ? 'Anyone can create a company from the sign-up page.'
          : 'The sign-up page is turned off; new people join only by invitation.'}{' '}
        {signup.source === 'environment'
          ? `Following the server setting PUBLIC_SIGNUP (${signup.environmentDefault ? 'on' : 'off'}).`
          : `Set here; it overrides the server setting PUBLIC_SIGNUP (${signup.environmentDefault ? 'on' : 'off'}).`}
      </p>
    </section>
  );
}

// ── Audit ───────────────────────────────────────────────────────────────────

export function PlatformAuditScreen({ client }: ScreenProps) {
  const api = client ?? browserApiClient();
  return (
    <PlatformGate
      api={api}
      section="audit"
      crumbs={['Audit log']}
      title="Platform audit log"
      description="Every platform action: who, when, why, and what it touched."
    >
      {() => <AuditBody api={api} />}
    </PlatformGate>
  );
}

function AuditBody({ api }: { api: ApiClient }) {
  const events = useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: () => listPlatformAudit(api),
  });
  if (events.isPending) return <Loading label="Loading the audit log." />;
  if (events.isError) {
    return (
      <InlineAlert tone="danger" title="Could not load the audit log" live>
        {describe(events.error)}
      </InlineAlert>
    );
  }
  if (events.data.length === 0) {
    return <InlineAlert tone="neutral">No platform actions yet.</InlineAlert>;
  }
  return (
    <section className="tm-cc-card tm-cc-card--flush" aria-label="Platform audit log">
      <table className="tm-table tm-cc-table" aria-label="Platform actions">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Action</th>
            <th scope="col">Target</th>
            <th scope="col">Reason</th>
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
