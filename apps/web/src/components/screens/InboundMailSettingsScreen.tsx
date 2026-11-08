'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useDescribeApiError } from '../../lib/api/describe-error';
import {
  createInboundAddress,
  getInboundAddress,
  listInboundLog,
  rotateInboundAddress,
  type InboundLogEntry,
} from '../../lib/api/inbound-email';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/inbound-mail.css';

export interface InboundMailSettingsScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

const K = 'InboundMail';

/** How many of the newest messages the settings screen lists. */
export const RECENT_MAIL_LIMIT = 5;

/** The outcome badge: what became of a message, in words, never a raw code. */
export function outcomeOf(entry: InboundLogEntry): {
  readonly key: string;
  readonly english: string;
  readonly tone: 'neutral' | 'client';
} {
  switch (entry.outcome) {
    case 'client_request':
      return { key: 'outcome.request', english: 'Request created', tone: 'client' };
    case 'work_item':
      return { key: 'outcome.workItem', english: 'Work item created', tone: 'client' };
    case 'held':
      return { key: 'outcome.held', english: 'Waiting for review', tone: 'neutral' };
    default:
      return { key: 'outcome.notAccepted', english: 'Not accepted', tone: 'neutral' };
  }
}

/**
 * **Inbound mail settings (54-12; Figma 575:32722 EN, 575:32929 AR).**
 *
 * The organization's inbound address with a copy button, a way to make a new address when the
 * old one leaks, who may send, and the newest messages with what became of each. Everything reads
 * and writes through the existing `…/inbound-email` API; nothing here reads a message body (the
 * log never returns one). Making a new address asks once before it retires the old one.
 */
export function InboundMailSettingsScreen({
  organizationSlug,
  organizationName,
  client,
}: InboundMailSettingsScreenProps) {
  const tr = useTOr();
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const addressKey = ['inbound-address', organizationSlug] as const;
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const address = useQuery({
    queryKey: addressKey,
    queryFn: () => getInboundAddress(api, organizationSlug),
  });
  const log = useQuery({
    queryKey: ['inbound-log', organizationSlug],
    queryFn: () => listInboundLog(api, organizationSlug),
  });

  const onSaved = () => {
    setCopied(false);
    setConfirmRotate(false);
    void queries.invalidateQueries({ queryKey: addressKey });
  };
  const create = useMutation({
    mutationFn: () => createInboundAddress(api, organizationSlug),
    onSuccess: onSaved,
  });
  const rotate = useMutation({
    mutationFn: () => rotateInboundAddress(api, organizationSlug),
    onSuccess: onSaved,
  });

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // No clipboard permission: the address stays on screen to select by hand.
      setCopied(false);
    }
  }

  const writeError = create.error ?? rotate.error;
  const current = address.data ?? null;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={tr(`${K}.eyebrow`, 'Settings')}
      title={tr(`${K}.title`, 'Inbound mail')}
      description={tr(
        `${K}.lede`,
        'Send mail to this address to turn it into a request in the project.',
      )}
    >
      <div className="tm-inmail">
        {writeError ? (
          <InlineAlert tone="danger" title={tr(`${K}.writeError`, 'That did not work')} live>
            {describe(writeError)}
          </InlineAlert>
        ) : null}

        <section className="tm-panel tm-stack" aria-labelledby="tm-inmail-address">
          <h2 id="tm-inmail-address" className="tm-inmail__title">
            {tr(`${K}.addressTitle`, 'Project address')}
          </h2>
          {address.isPending ? (
            <LoadingRegion label={tr(`${K}.loading`, 'Loading the address')}>
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}
          {address.isError ? (
            <InlineAlert tone="danger" title={tr(`${K}.loadError`, 'Could not load the address')}>
              {describe(address.error)}
            </InlineAlert>
          ) : null}
          {address.isSuccess && current === null ? (
            <div className="tm-stack">
              <p className="tm-prose">{tr(`${K}.noAddress`, 'There is no inbound address yet.')}</p>
              <div>
                <Button
                  tone="ink"
                  size="compact"
                  loading={create.isPending}
                  loadingLabel={tr(`${K}.creating`, 'Creating…')}
                  onClick={() => create.mutate()}
                >
                  {tr(`${K}.create`, 'Create address')}
                </Button>
              </div>
            </div>
          ) : null}
          {current !== null ? (
            <>
              <div className="tm-inmail__row">
                <code className="tm-inmail__address" dir="ltr">
                  {current.address}
                </code>
                <div className="tm-inmail__actions">
                  <Button tone="outline" size="compact" onClick={() => void copy(current.address)}>
                    {copied ? tr(`${K}.copied`, 'Copied') : tr(`${K}.copy`, 'Copy')}
                  </Button>
                  <Button tone="outline" size="compact" onClick={() => setConfirmRotate(true)}>
                    {tr(`${K}.rotate`, 'New address')}
                  </Button>
                </div>
              </div>
              {copied ? (
                <p className="tm-visually-hidden" role="status">
                  {tr(`${K}.copiedStatus`, 'Address copied')}
                </p>
              ) : null}
              {confirmRotate ? (
                <InlineAlert tone="warning" title={tr(`${K}.rotateTitle`, 'Make a new address?')}>
                  <p className="tm-prose">
                    {tr(
                      `${K}.rotateBody`,
                      'Mail sent to the old address will stop arriving. Give people the new one.',
                    )}
                  </p>
                  <div className="tm-inmail__actions">
                    <Button
                      tone="ink"
                      size="compact"
                      loading={rotate.isPending}
                      loadingLabel={tr(`${K}.rotating`, 'Making a new address…')}
                      onClick={() => rotate.mutate()}
                    >
                      {tr(`${K}.rotateConfirm`, 'Make a new address')}
                    </Button>
                    <Button tone="text" size="compact" onClick={() => setConfirmRotate(false)}>
                      {tr(`${K}.cancel`, 'Cancel')}
                    </Button>
                  </div>
                </InlineAlert>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-inmail-senders">
          <h2 id="tm-inmail-senders" className="tm-inmail__title">
            {tr(`${K}.sendersTitle`, 'Who can send')}
          </h2>
          <p className="tm-prose">
            {tr(
              `${K}.sendersBody`,
              'Clients of this organization and active members. Mail from anyone else waits for review.',
            )}
          </p>
        </section>

        <section className="tm-panel tm-stack" aria-labelledby="tm-inmail-recent">
          <h2 id="tm-inmail-recent" className="tm-inmail__title">
            {tr(`${K}.recentTitle`, 'Recent mail')}
          </h2>
          {log.isPending ? (
            <LoadingRegion label={tr(`${K}.recentLoading`, 'Loading recent mail')}>
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}
          {log.isError ? (
            <InlineAlert tone="danger" title={tr(`${K}.recentError`, 'Could not load recent mail')}>
              {describe(log.error)}
            </InlineAlert>
          ) : null}
          {log.isSuccess && log.data.length === 0 ? (
            <p className="tm-prose">{tr(`${K}.recentEmpty`, 'No mail has arrived yet.')}</p>
          ) : null}
          {log.isSuccess && log.data.length > 0 ? (
            <ul className="tm-inmail__list" aria-label={tr(`${K}.recentTitle`, 'Recent mail')}>
              {log.data.slice(0, RECENT_MAIL_LIMIT).map((entry) => {
                const outcome = outcomeOf(entry);
                return (
                  <li key={entry.id} className="tm-inmail__row">
                    <span className="tm-inmail__mail">
                      <span className="tm-inmail__subject">
                        {entry.subject ?? tr(`${K}.noSubject`, '(no subject)')}
                      </span>
                      <span className="tm-inmail__from" dir="ltr">
                        {entry.fromEmail}
                      </span>
                    </span>
                    <Badge tone={outcome.tone}>{tr(`${K}.${outcome.key}`, outcome.english)}</Badge>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
