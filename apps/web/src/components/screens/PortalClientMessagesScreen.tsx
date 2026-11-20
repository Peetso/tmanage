'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../shell/ClientPortalShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listClientMessages, postClientMessage } from '../../lib/api/portal';
import type { ClientMessage } from '../../lib/api/portal';
import { PORTAL_LINES, useDescribeApiError } from '../../lib/api/describe-error';
import type { ApiClient } from '../../lib/api/client';
import { usePortalNames } from '../../lib/use-organization-names';
import { useT } from '../../lib/i18n/use-t';
import { appLocale } from '../../lib/i18n/app-locale';

export interface PortalClientMessagesScreenProps {
  organizationSlug: string;
  /** The client's own name leads the header. `22` §1. */
  clientName: string;
  providerName: string;
  client?: ApiClient;
}

/**
 * **Client portal messages (x322)** — a client contact writes to the studio and reads their own thread.
 *
 * The compose form posts a subject and a body; the tenant, the client-org scope and the author come
 * from the session, never this form. The thread below is the caller's own messages only — the API
 * scopes the read to the caller's client organization, so there is nothing to filter here. It is an
 * in-app relay: sending a message does not email anyone.
 */
export function PortalClientMessagesScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  client,
}: PortalClientMessagesScreenProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  const thread = useQuery({
    queryKey: ['portal-messages', organizationSlug],
    queryFn: () => listClientMessages(api, organizationSlug),
  });

  const send = useMutation({
    mutationFn: () =>
      postClientMessage(api, organizationSlug, { subject: subject.trim(), body: body.trim() }),
    onSuccess: async () => {
      setSubject('');
      setBody('');
      await queryClient.invalidateQueries({ queryKey: ['portal-messages', organizationSlug] });
    },
  });

  const canSend = subject.trim() !== '' && body.trim() !== '' && !send.isPending;

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="messages"
      title={t('PortalClientMessagesScreen.title')}
      description={`${t('PortalClientMessagesScreen.descPrefix')} ${providerName} ${t('PortalClientMessagesScreen.descSuffix')}`}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-portal-messages-compose">
        <h2 id="tm-portal-messages-compose" className="tm-eyebrow">
          {t('PortalClientMessagesScreen.composeHeading')}
        </h2>

        {send.isError ? (
          <InlineAlert tone="danger" title={t('PortalClientMessagesScreen.sendErrorTitle')} live>
            {describe(send.error)}
          </InlineAlert>
        ) : null}

        <form
          noValidate
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) send.mutate();
          }}
        >
          <label className="tm-field">
            <span className="tm-field__label">{t('PortalClientMessagesScreen.subjectLabel')}</span>
            <input
              className="tm-input"
              type="text"
              value={subject}
              maxLength={190}
              onChange={(event) => setSubject(event.target.value)}
              required
            />
          </label>
          <label className="tm-field">
            <span className="tm-field__label">{t('PortalClientMessagesScreen.messageLabel')}</span>
            <textarea
              className="tm-input"
              value={body}
              maxLength={5000}
              rows={4}
              onChange={(event) => setBody(event.target.value)}
              required
            />
          </label>
          <div className="tm-row">
            <Button type="submit" disabled={!canSend}>
              {send.isPending
                ? t('PortalClientMessagesScreen.sending')
                : t('PortalClientMessagesScreen.sendButton')}
            </Button>
          </div>
        </form>
      </section>

      <ThreadSection
        providerName={providerName}
        messages={thread.data ?? []}
        isPending={thread.isPending}
        isError={thread.isError}
        error={thread.error}
      />
    </ClientPortalShell>
  );
}

interface ThreadSectionProps {
  providerName: string;
  messages: readonly ClientMessage[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

function ThreadSection({ providerName, messages, isPending, isError, error }: ThreadSectionProps) {
  const describe = useDescribeApiError(PORTAL_LINES);
  const t = useT();
  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-portal-messages-thread">
      <h2 id="tm-portal-messages-thread" className="tm-eyebrow">
        {t('PortalClientMessagesScreen.threadHeading')}
      </h2>

      {isError ? (
        <InlineAlert tone="danger" title={t('PortalClientMessagesScreen.loadErrorTitle')} live>
          {describe(error)}
        </InlineAlert>
      ) : isPending ? (
        <LoadingRegion label={t('PortalClientMessagesScreen.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : messages.length === 0 ? (
        <p className="tm-prose">
          {t('PortalClientMessagesScreen.emptyPrefix')} {providerName}{' '}
          {t('PortalClientMessagesScreen.emptySuffix')}
        </p>
      ) : (
        <ol className="tm-list tm-stack">
          {messages.map((message) => (
            <li key={message.id} className="tm-stack tm-stack--tight">
              <div className="tm-row tm-row--wrap">
                <strong>{message.subject}</strong>
                <time className="tm-push-end tm-muted" dateTime={message.createdAt}>
                  {formatSent(message.createdAt)}
                </time>
              </div>
              <p className="tm-prose">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatSent(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString(appLocale());
}
