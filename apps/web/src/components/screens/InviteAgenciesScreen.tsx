'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { createReferralCode, getReferral } from '../../lib/api/referrals';
import type { ReferralView } from '../../lib/api/referrals';
import { useActiveLocale } from '../../lib/i18n/use-active-locale';
import { localizedInviteLink } from '../../lib/referral-invite-link';
import { useTOr } from '../../lib/i18n/use-t-or';
import { INVITE_AGENCIES_COPY } from './invite-agencies-copy';
import type { InviteAgenciesCopyKey } from './invite-agencies-copy';
import '../../styles/screens/invite-agencies.css';
import { appDateLocale } from '../../lib/i18n/app-locale';

export interface InviteAgenciesScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests. Defaults to the address this app is served from. */
  origin?: string;
}

function useCopy(): (key: InviteAgenciesCopyKey) => string {
  const tOr = useTOr();
  return (key) => tOr(`InviteAgencies.${key}`, INVITE_AGENCIES_COPY[key]);
}

/** "12 Nov" / "12 نوفمبر" from the locale formatter (Latin digits, as drawn); never a string. */
function signedUpDay(iso: string, locale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const arabic = locale.toLowerCase().startsWith('ar');
  return new Intl.DateTimeFormat(appDateLocale(locale), {
    day: 'numeric',
    month: arabic ? 'long' : 'short',
  }).format(at);
}

/**
 * 57-08 REFERRAL — Settings › People › Invite agencies (Figma 724:39791 EN / 724:40204 AR, with
 * design review B points 5–9 and 22–24).
 *
 * Link-only: the owner's invite link with "Copy link", one tile "Agencies signed up", and the
 * agencies that signed up through it — name, date and a "Signed up" capsule. Never an e-mail
 * address or an "invited" count (a link cannot know who it was sent to). The API answers only
 * the workspace owner; anyone else reads the owner-only sentence. No reward is shown while
 * TManage is free in the beta (the API sends `rewards: null`).
 */
export function InviteAgenciesScreen({
  organizationSlug,
  organizationName,
  client,
  origin,
}: InviteAgenciesScreenProps) {
  const api = client ?? browserApiClient();
  const copy = useCopy();
  const locale = useActiveLocale();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ['referral', organizationSlug], [organizationSlug]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const referral = useQuery({
    queryKey,
    queryFn: () => getReferral(api, organizationSlug),
    retry: false,
  });

  // The link is made on the owner's first visit (one POST, idempotent on the server).
  const create = useMutation({
    mutationFn: () => createReferralCode(api, organizationSlug),
    onSuccess: (data: ReferralView) => queryClient.setQueryData(queryKey, data),
  });
  const asked = useRef(false);
  useEffect(() => {
    if (referral.data && referral.data.code === null && !asked.current) {
      asked.current = true;
      create.mutate();
    }
  }, [referral.data, create]);

  const here = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  const code = referral.data?.code ?? null;
  const link = code === null ? null : localizedInviteLink(here, code, locale);

  async function copyLink(): Promise<void> {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  const forbidden = referral.error instanceof ApiRequestError && referral.error.status === 403;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="invite-agencies"
      crumbs={[copy('navLabel')]}
      title={copy('title')}
      description={forbidden ? undefined : copy('lead')}
      client={api}
    >
      {forbidden ? (
        <InlineAlert tone="neutral">{copy('ownerOnly')}</InlineAlert>
      ) : referral.isError ? (
        <div className="tm-referral__error" role="alert">
          <InlineAlert tone="danger">{copy('loadFailed')}</InlineAlert>
          <Button tone="outline" onClick={() => void referral.refetch()}>
            {copy('retry')}
          </Button>
        </div>
      ) : referral.isPending ? (
        <LoadingRegion label={copy('preparing')} className="tm-referral">
          <Skeleton height="140px" radius="var(--r-card)" />
          <Skeleton height="96px" radius="var(--r-card)" />
        </LoadingRegion>
      ) : (
        <div className="tm-referral">
          <section className="tm-card tm-referral__card" aria-labelledby="tm-referral-link">
            <h2 id="tm-referral-link" className="tm-referral__heading">
              {copy('linkHeading')}
            </h2>
            <div className="tm-referral__link-row">
              <p className="tm-referral__link" dir="ltr">
                {link ?? copy('preparing')}
              </p>
              <Button
                tone="outline"
                size="feature"
                className="tm-referral__copy"
                disabled={link === null}
                onClick={() => void copyLink()}
              >
                {copy('copy')}
              </Button>
            </div>
            <p className="tm-referral__status" role="status">
              {copyState === 'copied'
                ? copy('copied')
                : copyState === 'failed'
                  ? copy('copyFailed')
                  : ''}
            </p>
            <p className="tm-referral__hint">{copy('linkHint')}</p>
          </section>

          <section className="tm-card tm-referral__stat" aria-labelledby="tm-referral-count">
            <p id="tm-referral-count" className="tm-referral__stat-label">
              {copy('statLabel')}
            </p>
            <p className="tm-referral__stat-value">{referral.data.signedUp}</p>
            {referral.data.rewards === null ? null : (
              <p className="tm-referral__hint">
                {copy('rewardsRecorded').replace('{count}', String(referral.data.rewards.recorded))}
              </p>
            )}
          </section>

          <section className="tm-card tm-referral__card" aria-labelledby="tm-referral-list">
            <h2 id="tm-referral-list" className="tm-referral__heading">
              {copy('listHeading')}
            </h2>
            {referral.data.agencies.length === 0 ? (
              <p className="tm-referral__empty">{copy('empty')}</p>
            ) : (
              <ul className="tm-referral__list">
                {referral.data.agencies.map((agency, index) => (
                  <li key={`${agency.signedUpAt}-${String(index)}`} className="tm-referral__row">
                    <span className="tm-referral__name" dir="auto">
                      {agency.name}
                    </span>
                    <StateCapsule state="done">{copy('signedUp')}</StateCapsule>
                    <time className="tm-referral__date" dateTime={agency.signedUpAt}>
                      {signedUpDay(agency.signedUpAt, locale)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="tm-referral__hint">{copy('selfNote')}</p>
        </div>
      )}
    </ControlCenterShell>
  );
}
