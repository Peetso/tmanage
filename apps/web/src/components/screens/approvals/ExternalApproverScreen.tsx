'use client';

import { useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton, StateCapsule } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import { useDescribeApiError } from '../../../lib/api/describe-error';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { useTOr } from '../../../lib/i18n/use-t-or';
import {
  decideAsApprover,
  openApproverLink,
  requestApproverCode,
  type ApproverDecision,
} from './ExternalApprovalApi';
import '../../../styles/screens/external-approver.css';

export interface ExternalApproverScreenProps {
  readonly token: string;
  readonly client?: ApiClient;
}

/** Bytes as "2.4 MB" — the approver only needs a rough size. */
export function roughSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * **Account-less approver** (`/a/<token>`, 52-18) — drawn as the R35 L3-52-18 Figma frame
 * "Approver link · Review and decide". No account: the page opens the 56-07 approval link,
 * shows the version read-only (title, version, file name/type/size; a watermark with the masked
 * address and the time), and takes one decision. Both decisions need the 6-digit code the API
 * mails to the address the link was sent to; the API re-checks the version's content hash, so a
 * link to a replaced version can no longer decide.
 */
export function ExternalApproverScreen({ token, client }: ExternalApproverScreenProps) {
  const api = client ?? browserApiClient();
  const tOr = useTOr();
  const describe = useDescribeApiError();
  const { day } = useDisplayFormatters();
  const commentId = useId();
  const [openedAt] = useState(() => new Date());

  const view = useQuery({
    queryKey: ['approver-link', token],
    queryFn: () => openApproverLink(api, token),
    retry: false,
  });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [decided, setDecided] = useState<string | null>(null);

  const askCode = useMutation({ mutationFn: () => requestApproverCode(api, token) });
  const decide = useMutation({
    mutationFn: (decision: ApproverDecision) =>
      decideAsApprover(api, token, {
        decision,
        versionHash: data?.state === 'active' ? data.versionHash : null,
        code: code.trim(),
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        ...(comment.trim() === '' ? {} : { comment: comment.trim() }),
      }),
    onSuccess: (result) => setDecided(result.decision),
  });

  const shell = (body: ReactNode) => (
    <main className="tm-approver">
      {body}
      <p className="tm-approver__footer">{tOr('PublicForm.poweredBy', 'Powered by TManage')}</p>
    </main>
  );

  if (view.isPending) {
    return shell(
      <div className="tm-card tm-approver__card">
        <LoadingRegion label={tOr('ApproverLink.loading', 'Loading the item')}>
          <Skeleton height="32px" />
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      </div>,
    );
  }

  const data = view.data;
  const decision = decided ?? (data?.state === 'decided' ? data.decision : null);

  if (decision !== null) {
    const approved = decision === 'approve';
    return shell(
      <div className="tm-card tm-approver__card tm-stack">
        <StateCapsule state={approved ? 'done' : 'waiting'}>
          {approved
            ? tOr('ApproverLink.approved', 'Approved')
            : tOr('ApproverLink.changesRequested', 'Changes requested')}
        </StateCapsule>
        <p>
          {approved
            ? tOr(
                'ApproverLink.approvedBody',
                'Thank you. Your approval has been recorded and the sender has been told.',
              )
            : tOr(
                'ApproverLink.changesBody',
                'Thank you. Your request for changes has been recorded and the sender has been told.',
              )}
        </p>
      </div>,
    );
  }

  if (view.isError || !data || data.state !== 'active') {
    return shell(
      <div className="tm-card tm-approver__card tm-stack">
        <h1 className="tm-approver__title">
          {tOr('ApproverLink.unavailableTitle', 'This link is no longer open')}
        </h1>
        <p className="tm-approver__muted">
          {tOr(
            'ApproverLink.unavailableBody',
            'The link has expired, was withdrawn, or a newer version was sent. Ask the sender for a new link.',
          )}
        </p>
      </div>,
    );
  }

  const item = data.projection;
  const hasCode = /^\d{6}$/u.test(code.trim());
  const canDecide = (d: ApproverDecision) =>
    data.decisions.includes(d) && hasCode && !decide.isPending;
  const watermark = `${data.audienceHint ?? ''} · ${openedAt.toISOString().slice(0, 16).replace('T', ' ')}`;

  return shell(
    <article className="tm-card tm-approver__card tm-stack" aria-labelledby="tm-approver-title">
      <span className="tm-approver__watermark" aria-hidden="true">
        {watermark}
      </span>
      <p className="tm-approver__muted">
        <bdi>{data.organizationName}</bdi> · {tOr('ApproverLink.request', 'Approval request')}
      </p>
      <h1 id="tm-approver-title" className="tm-approver__title">
        {item.title}
      </h1>
      <p className="tm-approver__muted">
        {item.versionNo === null
          ? null
          : `${tOr('ApproverLink.version', 'Version')} ${item.versionNo} · `}
        {tOr('ApproverLink.fingerprint', 'fingerprint')}{' '}
        <bdi className="tm-mono">…{item.hashTail ?? ''}</bdi>
      </p>

      <dl className="tm-approver__facts">
        <div>
          <dt>{tOr('ApproverLink.file', 'File')}</dt>
          <dd>
            {item.file === null ? (
              tOr('ApproverLink.noFile', 'No file attached')
            ) : (
              <bdi>
                {item.file.name}
                {item.file.sizeBytes === null ? '' : ` · ${roughSize(item.file.sizeBytes)}`}
              </bdi>
            )}
          </dd>
        </div>
        <div>
          <dt>{tOr('ApproverLink.shownTo', 'Shown to')}</dt>
          <dd>
            <bdi dir="ltr">{data.audienceHint ?? ''}</bdi> · {day(openedAt.toISOString())}
          </dd>
        </div>
      </dl>

      <p className="tm-approver__notice">
        {tOr(
          'ApproverLink.privacy',
          'Read-only preview. We record your name, e-mail, time and device so this decision can be traced. The watermark is a deterrent, not copy protection.',
        )}
      </p>

      <Field
        label={tOr('ApproverLink.name', 'Your name')}
        value={name}
        maxLength={120}
        autoComplete="name"
        onChange={(event) => setName(event.target.value)}
      />
      <div className="tm-field">
        <label className="tm-field__label" htmlFor={commentId}>
          {tOr('ApproverLink.comment', 'Comment (optional)')}
        </label>
        <textarea
          id={commentId}
          className="tm-field__control"
          rows={3}
          maxLength={1000}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>

      <div className="tm-approver__code">
        <Field
          label={tOr('ApproverLink.code', 'E-mail code')}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          dir="ltr"
          maxLength={6}
          onChange={(event) => setCode(event.target.value)}
          hint={
            askCode.isSuccess
              ? tOr('ApproverLink.codeSent', 'We sent a code to the address this link was sent to.')
              : undefined
          }
        />
        <Button
          type="button"
          tone="outline"
          loading={askCode.isPending}
          loadingLabel={tOr('ApproverLink.sendingCode', 'Sending a code')}
          onClick={() => askCode.mutate()}
        >
          {tOr('ApproverLink.sendCode', 'Send me a code')}
        </Button>
      </div>
      {askCode.isError ? (
        <InlineAlert tone="danger" live>
          {describe(askCode.error)}
        </InlineAlert>
      ) : null}
      {decide.isError ? (
        <InlineAlert
          tone="danger"
          title={tOr('ApproverLink.decideFailed', 'Your answer was not recorded')}
          live
        >
          {describe(decide.error)}
        </InlineAlert>
      ) : null}

      <div className="tm-row">
        <Button
          type="button"
          tone="lime"
          disabled={!canDecide('approve')}
          loading={decide.isPending && decide.variables === 'approve'}
          loadingLabel={tOr('ApproverLink.approving', 'Recording your approval')}
          onClick={() => decide.mutate('approve')}
        >
          {tOr('ApproverLink.approve', 'Approve')}
        </Button>
        <Button
          type="button"
          tone="outline"
          disabled={!canDecide('request_changes')}
          loading={decide.isPending && decide.variables === 'request_changes'}
          loadingLabel={tOr('ApproverLink.requesting', 'Recording your answer')}
          onClick={() => decide.mutate('request_changes')}
        >
          {tOr('ApproverLink.requestChanges', 'Request changes')}
        </Button>
      </div>
    </article>,
  );
}
