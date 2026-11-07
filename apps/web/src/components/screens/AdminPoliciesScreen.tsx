'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Select, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readOrgPolicy, updateOrgPolicy, type OrgPolicyUpdateInput } from '../../lib/api/policies';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { localizedHours } from '../admin/localized-time';
import './admin-label-spacing.css';

/** R3. The "Sign out after inactivity" choices, in minutes (0 = Off), as the API allows them. */
const IDLE_CHOICES = [0, 30, 60, 240, 480] as const;
const IDLE_LABEL_KEYS: Record<number, MessageKey> = {
  0: 'AdminPoliciesScreen.idleOff',
  30: 'AdminPoliciesScreen.idle30m',
  60: 'AdminPoliciesScreen.idle1h',
  240: 'AdminPoliciesScreen.idle4h',
  480: 'AdminPoliciesScreen.idle8h',
};

export interface AdminPoliciesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Organization access policies (Administration module 18, x174).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (access policies). This screen reads the organization's access
 * policy — session lifetime, the invite-domain allowlist, and whether guest access is enabled — and
 * updates it. It is a faithful reader of the API's fixed-key allowlist: the fields shown are exactly the
 * typed policies the API returns, and a save PUTs the document, which the API validates against its
 * allowlist and per-key validators (an out-of-range or bad value is refused, with no write).
 *
 * ## What it does, and what it cannot
 *
 * - **This is the access-policy surface, not general settings.** x153's org-settings screen holds the
 *   general preferences (timezone, re-auth window); this is session lifetime, invite domains and guest
 *   access.
 * - **The role / capability editor is not here.** ADM-03 is blocked pending the permission-matrix work;
 *   broader security-policy escalations are deferred (NEXT-SCOPES-13).
 */
export function AdminPoliciesScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminPoliciesScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const locale = useActiveLocale();

  const policy = useQuery({
    queryKey: ['org-policies', organizationSlug],
    queryFn: () => readOrgPolicy(api, organizationSlug),
  });

  const [sessionHours, setSessionHours] = useState('');
  const [domains, setDomains] = useState('');
  const [guestAccess, setGuestAccess] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState('480');
  const [saved, setSaved] = useState(false);

  // Seed the editable fields from the loaded document once it arrives.
  useEffect(() => {
    if (!policy.data) return;
    setSessionHours(String(policy.data.policy.session_max_hours));
    setDomains(policy.data.policy.invite_domain_allowlist.join(', '));
    setGuestAccess(policy.data.policy.guest_access_enabled);
    setIdleMinutes(String(policy.data.policy.idle_signout_minutes));
  }, [policy.data]);

  const save = useMutation({
    mutationFn: () => {
      const input: OrgPolicyUpdateInput = {
        session_max_hours: Number(sessionHours),
        invite_domain_allowlist: domains
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        guest_access_enabled: guestAccess,
        idle_signout_minutes: Number(idleMinutes),
      };
      return updateOrgPolicy(api, organizationSlug, input);
    },
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['org-policies', organizationSlug] });
    },
  });

  const current = policy.data?.policy;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="policies"
      crumbs={[t('AdminPoliciesScreen.crumbAccessPolicy')]}
      title={t('AdminPoliciesScreen.title')}
      actions={
        <Link
          href={`/${organizationSlug}/policies/simulate`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          {t('AdminPoliciesScreen.simulateAccess')}
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-org-policies-heading">
          <h2 id="tm-org-policies-heading" className="tm-cc-eyebrow">
            {t('AdminPoliciesScreen.policyHeading')}
          </h2>

          {policy.isError ? (
            <InlineAlert tone="danger" title={t('AdminPoliciesScreen.loadError')} live>
              {describeError(policy.error)}
            </InlineAlert>
          ) : null}

          {policy.isPending ? (
            <LoadingRegion label={t('AdminPoliciesScreen.loading')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!policy.isPending && !policy.isError ? (
            <form
              className="tm-stack"
              noValidate
              aria-label={t('AdminPoliciesScreen.formLabel')}
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setSaved(false);
                if (!save.isPending) save.mutate();
              }}
            >
              <ul className="tm-cc-rows">
                <li>
                  <div className="tm-cc-rows__grow">
                    <Field
                      label={t('AdminPoliciesScreen.inviteDomainLabel')}
                      name="invite_domain_allowlist"
                      value={domains}
                      onChange={(event) => setDomains(event.target.value)}
                      hint={t('AdminPoliciesScreen.inviteDomainHint')}
                    />
                  </div>
                </li>
                <li>
                  <div className="tm-cc-rows__grow">
                    <Field
                      label={t('AdminPoliciesScreen.sessionLifetimeLabel')}
                      name="session_max_hours"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={720}
                      value={sessionHours}
                      onChange={(event) => setSessionHours(event.target.value)}
                      hint={t('AdminPoliciesScreen.sessionLifetimeHint')}
                    />
                  </div>
                </li>
                <li>
                  <div className="tm-cc-rows__grow">
                    <Select
                      label={t('AdminPoliciesScreen.idleLabel')}
                      name="idle_signout_minutes"
                      value={idleMinutes}
                      onChange={(event) => setIdleMinutes(event.target.value)}
                      hint={t('AdminPoliciesScreen.idleHint')}
                    >
                      {IDLE_CHOICES.map((minutes) => (
                        <option key={minutes} value={String(minutes)}>
                          {t(IDLE_LABEL_KEYS[minutes] ?? 'AdminPoliciesScreen.idleOff')}
                        </option>
                      ))}
                    </Select>
                  </div>
                </li>
                <li>
                  <Checkbox
                    label={t('AdminPoliciesScreen.guestLabel')}
                    name="guest_access_enabled"
                    checked={guestAccess}
                    onChange={(event) => setGuestAccess(event.target.checked)}
                    hint={t('AdminPoliciesScreen.guestHint')}
                  />
                  <span className={guestAccess ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'}>
                    {guestAccess
                      ? t('AdminPoliciesScreen.pillOn')
                      : t('AdminPoliciesScreen.pillOff')}
                  </span>
                </li>
              </ul>

              {save.isError ? (
                <InlineAlert tone="danger" title={t('AdminPoliciesScreen.saveError')} live>
                  {describeError(save.error)}
                </InlineAlert>
              ) : null}
              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title={t('AdminPoliciesScreen.savedTitle')} live>
                  {t('AdminPoliciesScreen.savedBody')}
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={save.isPending}
                  loadingLabel={t('AdminPoliciesScreen.saving')}
                >
                  {t('AdminPoliciesScreen.save')}
                </Button>
              </div>
            </form>
          ) : null}
        </section>

        <section
          className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
          aria-labelledby="tm-org-policies-now"
        >
          <table className="tm-table tm-cc-table" aria-labelledby="tm-org-policies-now">
            <caption id="tm-org-policies-now" className="tm-visually-hidden">
              {t('AdminPoliciesScreen.tableCaption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('AdminPoliciesScreen.colInForce')}</th>
                <th scope="col" className="tm-cc-end">
                  {t('AdminPoliciesScreen.colValue')}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">
                    {t('AdminPoliciesScreen.rowInvitationsTitle')}
                  </span>
                  <span className="tm-cc-cell-sub">
                    {t('AdminPoliciesScreen.rowInvitationsSub')}
                  </span>
                </td>
                <td className="tm-cc-end">
                  <span className="tm-cc-cell-mono">
                    {current
                      ? current.invite_domain_allowlist.length > 0
                        ? current.invite_domain_allowlist.join(', ')
                        : t('AdminPoliciesScreen.anyDomain')
                      : '—'}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">
                    {t('AdminPoliciesScreen.rowSessionTitle')}
                  </span>
                  <span className="tm-cc-cell-sub">{t('AdminPoliciesScreen.rowSessionSub')}</span>
                </td>
                <td className="tm-cc-end">
                  <span className="tm-cc-cell-mono">
                    {current ? localizedHours(current.session_max_hours, locale) : '—'}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">{t('AdminPoliciesScreen.rowIdleTitle')}</span>
                  <span className="tm-cc-cell-sub">{t('AdminPoliciesScreen.rowIdleSub')}</span>
                </td>
                <td className="tm-cc-end">
                  <span className="tm-cc-cell-mono">
                    {current
                      ? t(
                          IDLE_LABEL_KEYS[current.idle_signout_minutes] ??
                            'AdminPoliciesScreen.idleOff',
                        )
                      : '—'}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">{t('AdminPoliciesScreen.rowGuestTitle')}</span>
                  <span className="tm-cc-cell-sub">{t('AdminPoliciesScreen.rowGuestSub')}</span>
                </td>
                <td className="tm-cc-end">
                  {current ? (
                    <span
                      className={
                        current.guest_access_enabled ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'
                      }
                    >
                      {current.guest_access_enabled
                        ? t('AdminPoliciesScreen.guestAllowed')
                        : t('AdminPoliciesScreen.pillOff')}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </ControlCenterShell>
  );
}
