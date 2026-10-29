'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { PasswordResetDialog } from './PasswordResetDialog';
import { describe, formatMoment, Loading, PlatformGate, ReasonAction } from './shared/platform-kit';
import type { ScreenProps } from './shared/platform-kit';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import { searchPlatformPeople, signOutPlatformPerson } from '../../lib/api/platform-admin';
import type { PlatformPersonView } from '../../lib/api/platform-admin';

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
  const [resetOpen, setResetOpen] = useState(false);
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
          <Button type="button" tone="outline" size="compact" onClick={() => setResetOpen(true)}>
            {t('PlatformAdminScreens.sendPasswordReset')}
          </Button>
        </div>
      </div>
      {resetOpen ? (
        <PasswordResetDialog
          api={api}
          person={person}
          onClose={(sent) => {
            setResetOpen(false);
            if (sent) setNotice(t('PlatformAdminScreens.resetEmailSent'));
          }}
        />
      ) : null}
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
