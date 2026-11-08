'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, Switch } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { SignInPolicyCard, SignInPolicyGrace } from '../admin/SignInPolicyCard';
import { CompanySignInCard } from '../admin/CompanySignInCard';
import { ScimProvisioningCard } from '../admin/ScimProvisioningCard';
import { browserApiClient } from '../../lib/api/browser-client';
import { readSecuritySettings, setSecuritySettings } from '../../lib/api/admin-security';
import { listOrgSessions } from '../../lib/api/admin-sessions';
import { shortDevice } from '../admin/format';
import { localizedSinceLabel } from '../admin/localized-time';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import './admin-label-spacing.css';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useOrganizationRole } from '../../lib/use-organization-names';
import { useTOr } from '../../lib/i18n/use-t-or';
import { appLocale } from '../../lib/i18n/app-locale';

export interface AdminSecurityScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Organization security settings** — ADM-08 "How people get in" (Administration module 18, x176).
 *
 * The left card is the sign-in posture the API stores — whether a second factor is required — and
 * saves it, carrying the stored IP allowlist through unchanged. Trusted network ranges have their
 * own screen (`/admin/ip-allowlist`), linked here, so the ranges are edited in one place rather than
 * duplicated on this form. The right column is ADM-08's "one thing to look at" (drawn only when the
 * posture gives a reason) and the live list of active sessions from `GET …/admin/sessions`.
 */
export function AdminSecurityScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminSecurityScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const locale = useActiveLocale();
  const tr = useTOr();
  // Wave 9 S8 (F09): the sign-in policy is the company owner's choice; everyone else reads it.
  const { role, known } = useOrganizationRole(organizationSlug);
  const readOnly = known && role !== 'owner';

  const settings = useQuery({
    queryKey: ['admin-security', organizationSlug],
    queryFn: () => readSecuritySettings(api, organizationSlug),
  });

  const sessions = useQuery({
    queryKey: ['admin-sessions', organizationSlug],
    queryFn: () => listOrgSessions(api, organizationSlug),
  });

  const [enforce2fa, setEnforce2fa] = useState(false);
  const [saved, setSaved] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Seed the editable form from the loaded posture once it arrives, without clobbering later edits.
  useEffect(() => {
    if (!settings.data || seeded) return;
    setEnforce2fa(settings.data.enforce2fa);
    setSeeded(true);
  }, [settings.data, seeded]);

  const save = useMutation({
    // Trusted network ranges are managed on their own screen; this save carries the stored list
    // through unchanged so saving the 2FA posture never clears it.
    mutationFn: () =>
      setSecuritySettings(api, organizationSlug, {
        enforce2fa,
        ipAllowlist: settings.data?.ipAllowlist ?? [],
      }),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['admin-security', organizationSlug] });
    },
  });

  const sessionRows = Array.isArray(sessions.data) ? sessions.data : [];
  const loaded = settings.isSuccess;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="security"
      crumbs={[t('AdminSecurityScreen.crumbSecurity')]}
      title={t('AdminSecurityScreen.title')}
      actions={
        <Link
          href={`/${organizationSlug}/admin/audit`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('AdminSecurityScreen.auditLogLink')}
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <div className="tm-cc-column">
          <section className="tm-cc-card" aria-labelledby="tm-admin-security-heading">
            <h2 id="tm-admin-security-heading" className="tm-visually-hidden">
              {t('AdminSecurityScreen.securityHeading')}
            </h2>

            {settings.isError ? (
              <InlineAlert tone="danger" title={t('AdminSecurityScreen.loadError')} live>
                {describeError(settings.error)}
              </InlineAlert>
            ) : null}

            {settings.isPending ? (
              <LoadingRegion label={t('AdminSecurityScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!settings.isPending && !settings.isError ? (
              <form
                className="tm-stack"
                noValidate
                aria-label={t('AdminSecurityScreen.formLabel')}
                onSubmit={(event: FormEvent<HTMLFormElement>) => {
                  event.preventDefault();
                  setSaved(false);
                  if (!save.isPending && !readOnly) save.mutate();
                }}
              >
                <ul className="tm-cc-rows">
                  <li>
                    <Switch
                      label={t('AdminSecurityScreen.require2faLabel')}
                      hint={
                        readOnly
                          ? tr(
                              'AdminSecurityScreen.s8.ownerOnly',
                              'Only the company owner can change this setting.',
                            )
                          : t('AdminSecurityScreen.require2faHint')
                      }
                      checked={enforce2fa}
                      disabled={save.isPending || readOnly}
                      onChange={(event) => {
                        setSaved(false);
                        setEnforce2fa(event.target.checked);
                      }}
                    />
                    <span className={enforce2fa ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'}>
                      {enforce2fa
                        ? t('AdminSecurityScreen.pillOn')
                        : t('AdminSecurityScreen.pillOff')}
                    </span>
                  </li>
                  <li>
                    <div className="tm-cc-rows__text">
                      <p className="tm-cc-rows__title">
                        {t('AdminSecurityScreen.sessionLengthTitle')}
                      </p>
                      <p className="tm-cc-rows__sub">{t('AdminSecurityScreen.sessionLengthSub')}</p>
                    </div>
                    <Link
                      href={`/${organizationSlug}/policies`}
                      className="tm-button tm-button--outline tm-button--compact"
                    >
                      {t('AdminSecurityScreen.edit')}
                    </Link>
                  </li>
                  <li>
                    <div className="tm-cc-rows__text">
                      <p className="tm-cc-rows__title">
                        {t('AdminSecurityScreen.trustedRangesTitle')}
                      </p>
                      <p className="tm-cc-rows__sub">{t('AdminSecurityScreen.trustedRangesSub')}</p>
                    </div>
                    <Link
                      href={`/${organizationSlug}/admin/ip-allowlist`}
                      className="tm-button tm-button--outline tm-button--compact"
                    >
                      {t('AdminSecurityScreen.ranges')}
                    </Link>
                  </li>
                </ul>

                {save.isError ? (
                  <InlineAlert tone="danger" title={t('AdminSecurityScreen.saveError')} live>
                    {describeError(save.error)}
                  </InlineAlert>
                ) : null}
                {saved && !save.isPending && !save.isError ? (
                  <InlineAlert tone="success" title={t('AdminSecurityScreen.savedTitle')} live>
                    {t('AdminSecurityScreen.savedBody')}
                  </InlineAlert>
                ) : null}

                {readOnly ? null : (
                  <div className="tm-row">
                    <Button
                      type="submit"
                      tone="ink"
                      size="accessible"
                      loading={save.isPending}
                      loadingLabel={t('AdminSecurityScreen.saving')}
                    >
                      {t('AdminSecurityScreen.save')}
                    </Button>
                  </div>
                )}
              </form>
            ) : null}
          </section>

          {/* A16: allowed sign-in methods and two-step by role (Figma R31 L08 A16). */}
          <SignInPolicyCard api={api} organizationSlug={organizationSlug} readOnly={readOnly} />

          {/* 54-14: company sign-in over OpenID Connect (Figma R41 L1 568:33048); owner only. */}
          <CompanySignInCard api={api} organizationSlug={organizationSlug} />

          {/* 54-16: SCIM provisioning keys beside company sign-in (Figma R49 L3 592:34040). */}
          <ScimProvisioningCard api={api} organizationSlug={organizationSlug} />
        </div>

        <div className="tm-cc-column">
          <SignInPolicyGrace api={api} organizationSlug={organizationSlug} />
          {loaded && !settings.data.enforce2fa ? (
            <section
              className="tm-cc-card tm-cc-card--attention"
              aria-labelledby="tm-admin-security-look"
            >
              <p className="tm-cc-eyebrow tm-cc-eyebrow--warning">
                {t('AdminSecurityScreen.oneThing')}
              </p>
              <h2 id="tm-admin-security-look" className="tm-cc-card__lead">
                {t('AdminSecurityScreen.noTwoFactorLead')}
              </h2>
              <p className="tm-cc-card__body">{t('AdminSecurityScreen.noTwoFactorBody')}</p>
            </section>
          ) : null}

          <section
            className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
            aria-label={t('AdminSecurityScreen.activeSessionsLabel')}
          >
            <table
              className="tm-table tm-cc-table"
              aria-label={t('AdminSecurityScreen.sessionsTableLabel')}
            >
              <thead>
                <tr>
                  <th scope="col">
                    {t('AdminSecurityScreen.colActiveSessions')}
                    {sessions.isSuccess ? ` · ${sessionRows.length}` : ''}
                  </th>
                  <th scope="col" className="tm-cc-end">
                    {t('AdminSecurityScreen.colLastSeen')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sessionRows.slice(0, 6).map((session) => (
                  <tr key={session.sessionId}>
                    <td>
                      <span className="tm-cc-cell-title">
                        {session.memberName} · {shortDevice(session.deviceLabel)}
                      </span>
                      <span className="tm-cc-cell-sub">
                        {t('AdminSecurityScreen.signedInPrefix')} {formatMoment(session.createdAt)}
                      </span>
                    </td>
                    <td className="tm-cc-end">
                      <span className="tm-cc-cell-mono">
                        {localizedSinceLabel(session.lastSeenAt, locale)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="tm-cc-card__inset tm-row tm-row--between">
              {sessions.isPending ? (
                <p className="tm-cc-note">{t('AdminSecurityScreen.loadingSessionsNote')}</p>
              ) : null}
              {sessions.isError ? (
                <p className="tm-cc-note">{describeError(sessions.error)}</p>
              ) : null}
              {sessions.isSuccess && sessionRows.length === 0 ? (
                <p className="tm-cc-note">{t('AdminSecurityScreen.nobodySignedIn')}</p>
              ) : null}
              <Link
                href={`/${organizationSlug}/admin/sessions`}
                className="tm-button tm-button--outline tm-button--compact"
              >
                {t('AdminSecurityScreen.seeEverySession')}
              </Link>
            </div>
          </section>
        </div>
      </div>
    </ControlCenterShell>
  );
}

function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    at,
  );
}
