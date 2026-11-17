'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import {
  checkMailBounce,
  clearMailBounce,
  type MailBounceStatus,
} from '../../lib/api/mail-bounces';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { useDisplayFormatters } from '../../lib/i18n/use-formatters';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useShellCapability } from '../shell/use-shell-capability';
import { withIsolates } from '../../lib/i18n/with-isolates';

const K = 'StoppedAddresses';

/**
 * Why we stopped, only as far as the API says: a `5.1.x` status ("bad destination mailbox") is the
 * one case the server's own words support "does not exist"; everything else keeps refusing mail.
 */
export function stoppedReason(status: Pick<MailBounceStatus, 'lastKind' | 'lastStatus'>) {
  return status.lastKind === 'hard' && status.lastStatus?.startsWith('5.1.') === true
    ? 'missing'
    : 'refusing';
}

interface Result {
  readonly address: string;
  readonly view: MailBounceStatus;
}

export interface StoppedAddressesCardProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
}

/**
 * 56-26 — Settings › Security, "Addresses we stopped sending to" (Figma 678:37661: empty 678:37766,
 * sending normally 678:37859, stopped 678:37889, confirm 678:37926; AR 678:38080 / 678:38110 /
 * 678:38147). One address at a time, the way the server stores them (a hash): check it, and when
 * TManage stopped sending to it, start again after a confirm. Rendered only for
 * `org.security.manage`; the address travels in the request body only.
 */
export function StoppedAddressesCard({ api, organizationSlug }: StoppedAddressesCardProps) {
  const t = useTOr();
  const describeError = useDescribeApiError();
  const formatters = useDisplayFormatters();
  const canUse = useShellCapability(organizationSlug, api);
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [confirming, setConfirming] = useState(false);
  const focusTo = useRef<'trigger' | 'result' | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // After the confirm step closes, focus goes back to where the person was (Cancel) or to the
  // announced result (Yes), never to the top of the page.
  useEffect(() => {
    if (focusTo.current === 'trigger') triggerRef.current?.querySelector('button')?.focus();
    if (focusTo.current === 'result') resultRef.current?.focus();
    focusTo.current = null;
  });

  const check = useMutation({
    mutationFn: (value: string) => checkMailBounce(api, organizationSlug, value),
    onSuccess: (view, value) => {
      setConfirming(false);
      setResult({ address: value, view });
    },
  });
  const clear = useMutation({
    mutationFn: (value: string) => clearMailBounce(api, organizationSlug, value),
    onSuccess: (view, value) => {
      setConfirming(false);
      setResult({ address: value, view });
      focusTo.current = 'result';
    },
  });

  if (!canUse('org.security.manage')) return null;

  const failure = check.isError ? check.error : clear.isError ? clear.error : null;
  const stopped = result?.view.status === 'suppressed' ? result : null;
  const named = (template: string) =>
    withIsolates(template, {
      address: result?.address ?? '',
      date:
        stopped?.view.suppressedAt == null
          ? ''
          : formatters.day(stopped.view.suppressedAt, { day: 'numeric', month: 'long' }),
    });

  return (
    <section className="tm-cc-card tm-stack" aria-labelledby="tm-admin-stopped">
      <h2 id="tm-admin-stopped" className="tm-cc-card__lead">
        {t(`${K}.heading`, 'Addresses we stopped sending to')}
      </h2>
      <p className="tm-cc-rows__sub">
        {t(
          `${K}.lede`,
          'When mail to an address keeps coming back, TManage stops sending to it so your company’s mail stays trusted. Check an address here and start sending to it again.',
        )}
      </p>

      <form
        className="tm-row tm-stopped__form"
        noValidate
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const value = address.trim();
          if (value === '' || check.isPending) return;
          clear.reset();
          check.mutate(value);
        }}
      >
        <Field
          className="tm-stopped__field"
          label={t(`${K}.field`, 'Check an e-mail address')}
          type="email"
          dir="ltr"
          autoComplete="off"
          placeholder="name@company.com"
          maxLength={320}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button
          type="submit"
          tone="outline"
          size="accessible"
          disabled={address.trim() === ''}
          loading={check.isPending}
          loadingLabel={t(`${K}.checking`, 'Checking')}
        >
          {t(`${K}.check`, 'Check')}
        </Button>
      </form>

      <div ref={resultRef} tabIndex={-1} className="tm-stack" aria-live="polite">
        {failure !== null ? (
          <InlineAlert tone="danger" title={t(`${K}.error`, 'We could not check this address')}>
            {describeError(failure)}
          </InlineAlert>
        ) : result === null ? null : stopped === null ? (
          <InlineAlert tone="success">
            {named(t(`${K}.sending`, 'We are sending to {address} normally.'))}
          </InlineAlert>
        ) : (
          <InlineAlert tone="warning">
            {named(
              stopped.view.suppressedAt === null
                ? t(`${K}.stoppedUndated`, 'We stopped sending to {address}.')
                : t(`${K}.stopped`, 'We stopped sending to {address} on {date}.'),
            )}{' '}
            {stoppedReason(stopped.view) === 'missing'
              ? t(`${K}.reasonMissing`, 'The mailbox does not exist.')
              : t(`${K}.reasonRefusing`, 'The mailbox keeps refusing mail.')}
          </InlineAlert>
        )}
      </div>

      {stopped !== null && confirming ? (
        <>
          <p className="tm-prose">
            {t(
              `${K}.confirm`,
              'We will send to this address again. If mail keeps coming back, we stop again on our own.',
            )}
          </p>
          <div className="tm-row">
            <Button
              tone="outline"
              size="accessible"
              onClick={() => {
                setConfirming(false);
                focusTo.current = 'trigger';
              }}
            >
              {t(`${K}.cancel`, 'Cancel')}
            </Button>
            <Button
              tone="ink"
              size="accessible"
              loading={clear.isPending}
              loadingLabel={t(`${K}.resuming`, 'Starting again')}
              onClick={() => clear.mutate(stopped.address)}
            >
              {t(`${K}.yes`, 'Yes, send to it again')}
            </Button>
          </div>
        </>
      ) : null}
      {stopped !== null && !confirming ? (
        <div ref={triggerRef} className="tm-row">
          <Button tone="outline" size="accessible" onClick={() => setConfirming(true)}>
            {t(`${K}.resume`, 'Send to it again')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
