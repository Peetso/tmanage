'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert, Select } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import { ApiRequestError } from '../../../lib/api/errors';
import { updatePlatformPerson } from '../../../lib/api/platform-people';
import type {
  PlatformPersonDetailView,
  PlatformProfileChangeInput,
} from '../../../lib/api/platform-people';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useT } from '../../../lib/i18n/use-t';
import type { ScreenProps } from '../shared/platform-kit';
import { REASON_MAX, platformErrorText } from '../shared/ReasonDialog';
import { relativeMoment } from '../team/PlatformTeamScreen';
import { dayAndTime, deviceOf, firstNameOf, fullDay } from './people-format';
import { PersonFrame, roleName } from './PersonFrame';
import { TimeZoneSelect } from '../../TimeZoneSelect';
import type { PersonScreenContext } from './PersonFrame';

type T = ReturnType<typeof useT>;

/** B2 · Profile — `/platform/people/:userId` (frames 434:16180, 434:16415 disabled, 434:16652). */
export function PersonProfileScreen({ client, userId }: ScreenProps & { userId: string }) {
  const api = client ?? browserApiClient();
  return (
    <PersonFrame api={api} userId={userId} tab="profile">
      {/* Keyed on the person, not the email: an email save refreshes `person.email`, and a
          remount there would drop the "every session ended" notice the save just set. */}
      {(context) => <ProfileBody key={context.person.id} {...context} />}
    </PersonFrame>
  );
}

function ProfileBody({ api, me, person, refresh }: PersonScreenContext) {
  const t = useT();
  const locale = useActiveLocale();
  const canEdit = me.permissions.includes('platform.people.edit');
  const [displayName, setDisplayName] = useState(person.displayName);
  const [email, setEmail] = useState(person.email);
  const [language, setLanguage] = useState(person.locale);
  const [timezone, setTimezone] = useState(person.timezone);
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const first = firstNameOf(person.displayName);
  const emailChanged = email.trim().toLowerCase() !== person.email.toLowerCase();

  const change = (): PlatformProfileChangeInput => ({
    ...(displayName.trim() !== person.displayName ? { displayName: displayName.trim() } : {}),
    ...(emailChanged ? { email: email.trim().toLowerCase() } : {}),
    ...(language !== person.locale ? { locale: language } : {}),
    ...(timezone !== person.timezone ? { timezone } : {}),
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  });
  const dirty = Object.keys(change()).some((key) => key !== 'reason');

  const save = useMutation({
    mutationFn: () => updatePlatformPerson(api, person.id, change()),
    onSuccess: async () => {
      setSaved(
        emailChanged
          ? `${t('PlatformPeople.savedEmail')} ${email.trim().toLowerCase()}.`
          : t('PlatformPeople.saved'),
      );
      setReason('');
      await refresh();
    },
  });
  const taken =
    save.error instanceof ApiRequestError && save.error.status === 409
      ? t('PlatformPeople.emailTaken')
      : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(null);
    if (dirty) save.mutate();
  }

  return (
    <div className="tm-cc-split">
      <section className="tm-cc-card tm-stack" aria-labelledby="pa06-profile-title">
        <div className="tm-stack tm-stack--tight">
          <h3 id="pa06-profile-title" className="tm-cc-card__title">
            {t('PlatformPeople.profileTitle')}
          </h3>
          <p className="tm-cc-note">{t('PlatformPeople.profileLead')}</p>
        </div>
        <form className="tm-cc-form tm-stack" onSubmit={submit} noValidate>
          <Field
            label={t('PlatformPeople.displayName')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            disabled={!canEdit}
            maxLength={120}
          />
          <Field
            label={t('PlatformPeople.email')}
            type="email"
            dir="ltr"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={!canEdit}
            {...(emailChanged ? { hint: `${t('PlatformPeople.was')} ${person.email}` } : {})}
            {...(taken ? { error: taken } : {})}
          />
          {emailChanged ? (
            <InlineAlert tone="warning">
              {`${t('PlatformPeople.emailWarning1')} ${first}${t('PlatformPeople.emailWarning2')}`}
            </InlineAlert>
          ) : null}
          <div className="tm-cc-form__pair">
            <Select
              label={t('PlatformPeople.language')}
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={!canEdit}
              hint={t('PlatformPeople.languageHint')}
            >
              <option value="en">English</option>
              <option value="ar">العربية</option>
            </Select>
            <TimeZoneSelect
              label={t('PlatformPeople.timezone')}
              value={timezone}
              onChange={setTimezone}
              disabled={!canEdit}
            />
          </div>
          <Field
            label={t('PlatformPeople.reasonOptional')}
            placeholder={t('PlatformPeople.reasonPlaceholder')}
            hint={t('PlatformPeople.reasonNote')}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={REASON_MAX}
            disabled={!canEdit}
          />
          {save.isError && !taken ? (
            <InlineAlert tone="danger" title={t('PlatformShared.notDone')} live>
              {platformErrorText(save.error, t)}
            </InlineAlert>
          ) : null}
          {saved ? (
            <InlineAlert tone="success" live>
              {saved}
            </InlineAlert>
          ) : null}
          {canEdit ? (
            <div className="tm-cc-card__actions tm-cc-end">
              <Button
                type="button"
                tone="outline"
                disabled={!dirty}
                onClick={() => {
                  setDisplayName(person.displayName);
                  setEmail(person.email);
                  setLanguage(person.locale);
                  setTimezone(person.timezone);
                  setReason('');
                  save.reset();
                }}
              >
                {t('PlatformPeople.discard')}
              </Button>
              <Button
                type="submit"
                tone="ink"
                disabled={!dirty}
                loading={save.isPending}
                loadingLabel={t('PlatformShared.working')}
              >
                {t('PlatformPeople.saveChanges')}
              </Button>
            </div>
          ) : null}
        </form>
      </section>

      <div className="tm-cc-column">
        <FactsCard person={person} t={t} locale={locale} />
        <section className="tm-cc-card tm-stack" aria-labelledby="pa06-orgs-title">
          <div className="tm-cc-card__head">
            <h3 id="pa06-orgs-title" className="tm-cc-card__title">
              {t('PlatformPeople.organizationsCard')}
            </h3>
            <Link href={`/platform/people/${person.id}/organizations`}>
              {t('PlatformPeople.manage')}
            </Link>
          </div>
          <ul className="tm-cc-rows">
            {person.companies.map((company) => (
              <li key={`${company.audience}:${company.id}`}>
                <span className="tm-cc-rows__title">{company.name}</span>
                <span
                  className={`tm-cc-pill${company.audience === 'client' ? ' tm-cc-pill--client' : ''}`}
                >
                  {company.audience === 'client'
                    ? t('PlatformPeople.clientMember')
                    : roleName(t, company.role, null)}
                </span>
              </li>
            ))}
            {person.companies.length === 0 ? (
              <li className="tm-cc-rows__sub">{t('PlatformPeople.noOrganizations')}</li>
            ) : null}
          </ul>
        </section>
        <section className="tm-cc-card tm-stack" aria-labelledby="pa06-access-title">
          <div className="tm-cc-card__head">
            <h3 id="pa06-access-title" className="tm-cc-card__title">
              {t('PlatformPeople.recentAccess')}
            </h3>
            <Link href={`/platform/people/${person.id}/security`}>
              {t('PlatformPeople.accessLog')}
            </Link>
          </div>
          <ul className="tm-cc-rows">
            {person.recentAccess.map((event) => (
              <li key={event.id}>
                <span className="tm-cc-rows__text">
                  <span className="tm-cc-rows__title">
                    {event.outcome === 'succeeded'
                      ? t('PlatformPeople.signedIn')
                      : accessReason(t, event.reason)}
                  </span>
                  <span className="tm-cc-rows__sub">
                    {relativeMoment(event.occurredAt, locale)} ·{' '}
                    <bdi dir="ltr">{event.ip ?? '—'}</bdi>
                  </span>
                </span>
              </li>
            ))}
            {person.recentAccess.length === 0 ? (
              <li className="tm-cc-rows__sub">{t('PlatformPeople.noAccess')}</li>
            ) : null}
          </ul>
        </section>
        <section className="tm-cc-card tm-stack" aria-labelledby="pa06-actions-title">
          <div className="tm-cc-card__head">
            <h3 id="pa06-actions-title" className="tm-cc-card__title">
              {t('PlatformPeople.recentActions')}
            </h3>
            <Link href={`/platform/audit?actorUserId=${encodeURIComponent(person.id)}`}>
              {t('PlatformPeople.openActionLog')}
            </Link>
          </div>
          <ul className="tm-cc-rows">
            {person.recentActions.map((action) => (
              <li key={action.id}>
                <span className="tm-cc-rows__text">
                  <span className="tm-cc-rows__title tm-cc-cell-mono">{action.action}</span>
                  <span className="tm-cc-rows__sub">
                    {action.organizationName} · {dayAndTime(action.occurredAt, locale)}
                  </span>
                </span>
              </li>
            ))}
            {person.recentActions.length === 0 ? (
              <li className="tm-cc-rows__sub">{t('PlatformPeople.noActions')}</li>
            ) : null}
          </ul>
        </section>
      </div>
    </div>
  );
}

function FactsCard({
  person,
  t,
  locale,
}: {
  person: PlatformPersonDetailView;
  t: T;
  locale: string;
}) {
  const facts = person.facts;
  return (
    <section className="tm-cc-card tm-stack" aria-labelledby="pa06-facts-title">
      <h3 id="pa06-facts-title" className="tm-cc-card__title">
        {t('PlatformPeople.accountFacts')}
      </h3>
      <dl className="tm-cc-dl">
        <dt>{t('PlatformPeople.factCreated')}</dt>
        <dd>{fullDay(facts.createdAt, locale)}</dd>
        <dt>{t('PlatformPeople.factVerified')}</dt>
        <dd>
          {facts.emailVerifiedAt
            ? fullDay(facts.emailVerifiedAt, locale)
            : t('PlatformPeople.notVerified')}
        </dd>
        <dt>{t('PlatformPeople.factLastSignIn')}</dt>
        <dd>
          {facts.lastSignInAt
            ? `${relativeMoment(facts.lastSignInAt, locale)} · ${deviceOf(facts.lastSignInDevice)}`
            : '—'}
        </dd>
        <dt>{t('PlatformPeople.factTwoStep')}</dt>
        <dd>
          {person.mfaEnabled
            ? `${t('PlatformPeople.on')} · ${t('PlatformPeople.authenticatorApp')}`
            : t('PlatformPeople.off')}
        </dd>
        <dt>{t('PlatformPeople.factTokens')}</dt>
        <dd>{facts.personalAccessTokens}</dd>
        <dt>{t('PlatformPeople.factGrants')}</dt>
        <dd>{facts.aiAppGrants}</dd>
      </dl>
    </section>
  );
}

export function accessReason(t: T, reason: string | null): string {
  switch (reason) {
    case 'bad_password':
      return t('PlatformPeople.wrongPassword');
    case 'account_disabled':
      return t('PlatformPeople.accountDisabledReason');
    case 'locked_out':
    case 'rate_limited':
      return t('PlatformPeople.lockedOut');
    case 'mfa_bad_code':
    case 'mfa_replayed':
    case 'recovery_code_invalid':
    case 'recovery_code_spent':
      return t('PlatformPeople.wrongCode');
    case 'no_password_set':
      return t('PlatformPeople.noPasswordSet');
    case null:
      return t('PlatformPeople.failedSignIn');
    default:
      return reason.replace(/_/gu, ' ');
  }
}
