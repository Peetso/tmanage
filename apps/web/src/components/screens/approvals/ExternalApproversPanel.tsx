'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { CapsuleState } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useActiveLocale } from '../../../lib/i18n/use-active-locale';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import {
  listExternalApprovers,
  sendExternalApproval,
  type ExternalApprover,
} from './ExternalApprovalApi';
import '../../../styles/screens/external-approver.css';

export interface ExternalApproversPanelProps {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  readonly deliverableId: string;
  readonly versionId: string;
  readonly versionNo: number | null;
}

/** The capsule and label key of one sent request, from its decision and the link's state. */
export function approverState(row: ExternalApprover): {
  readonly capsule: CapsuleState;
  readonly key: string;
  readonly english: string;
} {
  if (row.decision === 'approve') {
    return { capsule: 'done', key: 'ExternalApprovers.approved', english: 'Approved' };
  }
  if (row.decision === 'request_changes') {
    return {
      capsule: 'waiting',
      key: 'ExternalApprovers.changesRequested',
      english: 'Changes requested',
    };
  }
  if (row.linkStatus === 'expired' || row.linkStatus === 'revoked') {
    return { capsule: 'neutral', key: 'ExternalApprovers.closed', english: 'Link closed' };
  }
  return { capsule: 'client', key: 'ExternalApprovers.waiting', english: 'Waiting' };
}

/**
 * **Send for approval to someone outside** (52-18, R35 L3-52-18 Figma frame "Deliverable version ·
 * Send for external approval"). A member with `deliverable.publish` types an e-mail; the API
 * mails a link and a 6-digit code, no account needed. The list shows who was asked and what they
 * answered (verified by the code). The link is shown once after sending so it can be copied.
 */
export function ExternalApproversPanel({
  api,
  organizationSlug,
  deliverableId,
  versionId,
  versionNo,
}: ExternalApproversPanelProps) {
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const locale = useActiveLocale();
  const { day } = useDisplayFormatters();
  const queryClient = useQueryClient();
  const messageId = useId();
  const queryKey = ['external-approvers', organizationSlug, versionId];

  const list = useQuery({
    queryKey,
    queryFn: () => listExternalApprovers(api, organizationSlug, deliverableId, versionId),
  });
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState('7');
  const [lastUrl, setLastUrl] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      sendExternalApproval(api, organizationSlug, deliverableId, versionId, {
        email: email.trim(),
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        ...(message.trim() === '' ? {} : { message: message.trim() }),
        expiresInDays: Number.parseInt(days, 10) || 7,
        language: locale.startsWith('ar') ? 'ar' : 'en',
      }),
    onSuccess: (sent) => {
      setLastUrl(
        sent.url.startsWith('/') && typeof window !== 'undefined'
          ? `${window.location.origin}${sent.url}`
          : sent.url,
      );
      setEmail('');
      setName('');
      setMessage('');
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  const canSend = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim()) && !send.isPending;

  return (
    <section className="tm-card tm-prj-card" aria-labelledby="tm-external-approvers">
      <h2 id="tm-external-approvers" className="tm-prj-eyebrow">
        {tOr('ExternalApprovers.heading', 'Send for approval')}
        {versionNo === null ? null : ` · v${versionNo}`}
      </h2>
      <p className="tm-field__hint">
        {tOr(
          'ExternalApprovers.hint',
          'No account needed. They get a link and a 6-digit code by e-mail.',
        )}
      </p>
      <form
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) send.mutate();
        }}
      >
        <Field
          label={tOr('ExternalApprovers.email', 'Approver e-mail')}
          type="email"
          dir="ltr"
          value={email}
          maxLength={320}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label={tOr('ExternalApprovers.name', 'Name (optional)')}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="tm-field">
          <label className="tm-field__label" htmlFor={messageId}>
            {tOr('ExternalApprovers.message', 'Message (optional)')}
          </label>
          <textarea
            id={messageId}
            className="tm-field__control"
            rows={2}
            maxLength={1000}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <Field
          label={tOr('ExternalApprovers.days', 'Link open for (days)')}
          inputMode="numeric"
          dir="ltr"
          value={days}
          maxLength={2}
          onChange={(event) => setDays(event.target.value.replace(/\D/gu, ''))}
        />
        {send.isError ? (
          <InlineAlert
            tone="danger"
            title={tOr('ExternalApprovers.sendFailed', 'The request was not sent')}
            live
          >
            {describe(send.error)}
          </InlineAlert>
        ) : null}
        {lastUrl !== null ? (
          <InlineAlert tone="success" title={tOr('ExternalApprovers.sent', 'Sent')} live>
            {tOr('ExternalApprovers.copyHint', 'You can also share this link by hand:')}{' '}
            <bdi dir="ltr" className="tm-mono">
              {lastUrl}
            </bdi>
          </InlineAlert>
        ) : null}
        <div className="tm-row">
          <Button
            type="submit"
            tone="lime"
            disabled={!canSend}
            loading={send.isPending}
            loadingLabel={tOr('ExternalApprovers.sending', 'Sending')}
          >
            {tOr('ExternalApprovers.send', 'Send for approval')}
          </Button>
        </div>
      </form>

      {list.data && list.data.length > 0 ? (
        <>
          <h3 className="tm-prj-eyebrow">
            {tOr('ExternalApprovers.listHeading', 'Sent to people outside')}
          </h3>
          <ul className="tm-approver-panel__list">
            {list.data.map((row) => {
              const state = approverState(row);
              return (
                <li key={row.id}>
                  <span>
                    <bdi dir="ltr">{row.email}</bdi>
                    {row.comment ? <span className="tm-field__hint"> — {row.comment}</span> : null}
                  </span>
                  <span className="tm-row">
                    <StateCapsule state={state.capsule}>
                      {tOr(state.key, state.english)}
                    </StateCapsule>
                    {row.decidedAt !== null ? (
                      <span className="tm-meta-mono">
                        {row.emailVerified
                          ? tOr('ExternalApprovers.verified', 'verified')
                          : tOr('ExternalApprovers.unverified', 'unverified')}{' '}
                        · {day(row.decidedAt)}
                      </span>
                    ) : row.expiresAt !== null ? (
                      <span className="tm-meta-mono">
                        {tOr('ExternalApprovers.openUntil', 'open until')} {day(row.expiresAt)}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
