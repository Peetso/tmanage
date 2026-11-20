'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import {
  createPartnerCode,
  fetchPlatformReferrals,
  inviteLinkFor,
} from '../../../lib/api/referrals';
import type { ReferralOutcome } from '../../../lib/api/referrals';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import { PlatformPageState } from '../shared/PlatformPageState';
import { ACTIVITY_KEY } from './ActivityFrame';

const COPY = {
  title: 'Invite links and partners',
  description:
    'Sign-ups through workspace invite links, and partner codes for companies that resell TManage. Workspace names only, never a person.',
  outcome_counted: 'Counted',
  outcome_self: 'Own sign-up',
  outcome_same_domain: 'Same company',
  outcome_rate_limited: 'Over the daily limit',
  partnersTitle: 'Partners',
  partnerName: 'Partner name',
  addPartner: 'Add partner',
  addFailed: 'The partner was not added. Try again.',
  colLink: 'Link',
  colSignedUp: 'Signed up',
  colWorkspace: 'Workspace',
  colOutcome: 'Result',
  colDate: 'Date',
  emptyTitle: 'No partners yet',
  emptyBody: 'Add a partner to give a reseller its own link.',
} as const;

type CopyKey = keyof typeof COPY;

/**
 * 57-08 REFERRAL — the Platform admin card on the Growth page: workspace invite-link totals by
 * result (counted, own sign-up, same company, over the daily limit), then the partner codes, each
 * with its own sign-up list. `GET /v1/platform/referrals` (`platform.activity.view`); "Add
 * partner" posts to `…/partners` (`platform.settings.edit`, audited).
 */
export function ReferralPartnersCard({ api }: { api: ApiClient }) {
  const tOr = useTOr();
  const copy = (key: CopyKey) => tOr(`PlatformReferrals.${key}`, COPY[key]);
  const outcome = (value: ReferralOutcome) => copy(`outcome_${value}`);
  const format = useDisplayFormatters();
  const queryClient = useQueryClient();
  const queryKey = [...ACTIVITY_KEY, 'referrals'];
  const [name, setName] = useState('');
  const referrals = useQuery({ queryKey, queryFn: () => fetchPlatformReferrals(api) });
  const add = useMutation({
    mutationFn: (partnerName: string) => createPartnerCode(api, partnerName),
    onSuccess: () => {
      setName('');
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() !== '') add.mutate(name.trim());
  };

  return (
    <section className="tm-cc-card" aria-labelledby="tm-referrals-title">
      <h2 id="tm-referrals-title" className="tm-cc-card__title">
        {copy('title')}
      </h2>
      <p className="tm-r44-sub">{copy('description')}</p>
      {referrals.isPending ? <PlatformPageState state="loading" /> : null}
      {referrals.isError ? (
        <PlatformPageState
          state="error"
          error={referrals.error}
          onRetry={() => void referrals.refetch()}
        />
      ) : null}
      {referrals.data ? (
        <>
          <ul className="tm-cc-metrics tm-r44-kpis" aria-label={copy('title')}>
            {(['counted', 'self', 'same_domain', 'rate_limited'] as const).map((key) => (
              <li key={key} className="tm-cc-metric">
                <p className="tm-cc-metric__source">{outcome(key)}</p>
                <p className="tm-cc-metric__value">
                  {format.number(referrals.data.workspaceTotals[key])}
                </p>
              </li>
            ))}
          </ul>

          <h3 className="tm-cc-card__title">{copy('partnersTitle')}</h3>
          <form noValidate className="tm-stack tm-stack--tight" onSubmit={submit}>
            <Field
              label={copy('partnerName')}
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" tone="outline" disabled={add.isPending || name.trim() === ''}>
              {copy('addPartner')}
            </Button>
          </form>
          {add.isError ? <InlineAlert tone="danger">{copy('addFailed')}</InlineAlert> : null}

          {referrals.data.partners.length === 0 ? (
            <PlatformPageState state="empty" title={copy('emptyTitle')} body={copy('emptyBody')} />
          ) : (
            referrals.data.partners.map((partner) => (
              <div key={partner.id}>
                <table className="tm-table tm-cc-table">
                  <caption>
                    <bdi>{partner.name}</bdi> · {copy('colSignedUp')}:{' '}
                    {format.number(partner.counted)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{copy('colLink')}</th>
                      <td className="tm-cc-cell-mono" colSpan={2} dir="ltr">
                        {inviteLinkFor(origin, partner.code)}
                      </td>
                    </tr>
                    <tr>
                      <th scope="col">{copy('colWorkspace')}</th>
                      <th scope="col">{copy('colOutcome')}</th>
                      <th scope="col">{copy('colDate')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {partner.signups.map((signup, index) => (
                      <tr key={`${signup.signedUpAt}-${String(index)}`}>
                        <th scope="row">
                          <bdi>{signup.name}</bdi>
                        </th>
                        <td>{outcome(signup.outcome)}</td>
                        <td className="tm-cc-cell-mono">{format.day(signup.signedUpAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </>
      ) : null}
    </section>
  );
}
