'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { listApprovers, type DeliverableVersionView } from '../../../lib/api/deliverables';
import {
  createSignatureRequest,
  listSignatureRequests,
  type SignatureRequestView,
} from '../../../lib/api/esign';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import { useEsignT } from './esign-copy';
import '../../../styles/screens/esign.css';

export interface SignatureRequestsPanelProps {
  api: ApiClient;
  organizationSlug: string;
  deliverableId: string;
  deliverableTitle: string;
  /** The current version — the one a new request pins. */
  version: DeliverableVersionView;
}

export function signatureRequestHref(organizationSlug: string, requestId: string): string {
  return `/${organizationSlug}/signatures/${encodeURIComponent(requestId)}`;
}

/**
 * 52-26 on the deliverable: "Request signature" for the current version and the version's
 * requests, each linking to its status page.
 */
export function SignatureRequestsPanel({
  api,
  organizationSlug,
  deliverableId,
  deliverableTitle,
  version,
}: SignatureRequestsPanelProps) {
  const t = useEsignT();
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const requests = useQuery({
    queryKey: ['signature-requests', organizationSlug, version.id],
    queryFn: () => listSignatureRequests(api, organizationSlug, version.id),
    retry: false,
  });
  const rows = requests.data?.requests ?? [];

  return (
    <section className="tm-card tm-prj-card tm-arec" aria-labelledby={headingId}>
      <div className="tm-arec__head">
        <h2 id={headingId} className="tm-prj-eyebrow">
          {t('panelTitle')}
        </h2>
        <Button tone="outline" size="compact" onClick={() => setOpen(true)}>
          {t('requestSignature')}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="tm-arec__muted">{t('panelEmpty')}</p>
      ) : (
        <ul className="tm-esign-requests">
          {rows.map((request) => (
            <RequestRow key={request.id} organizationSlug={organizationSlug} request={request} />
          ))}
        </ul>
      )}
      {open ? (
        <RequestSignatureSheet
          api={api}
          organizationSlug={organizationSlug}
          deliverableId={deliverableId}
          deliverableTitle={deliverableTitle}
          version={version}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  );
}

function RequestRow({
  organizationSlug,
  request,
}: {
  organizationSlug: string;
  request: SignatureRequestView;
}) {
  const t = useEsignT();
  const done = request.state === 'completed';
  return (
    <li className="tm-esign-requests__row">
      <Link href={signatureRequestHref(organizationSlug, request.id)} dir="auto">
        {request.title}
      </Link>
      <StateCapsule state={done ? 'done' : request.state === 'pending' ? 'waiting' : 'archived'}>
        {t('signedCount', {
          signed: String(request.signedCount),
          total: String(request.signers.length),
        })}
      </StateCapsule>
    </li>
  );
}

function RequestSignatureSheet({
  api,
  organizationSlug,
  deliverableId,
  deliverableTitle,
  version,
  onClose,
}: Omit<SignatureRequestsPanelProps, 'version'> & {
  version: DeliverableVersionView;
  onClose: () => void;
}) {
  const t = useEsignT();
  const describe = useDescribeApiError(OFFLINE_LINES);
  const router = useRouter();
  const titleId = useId();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [days, setDays] = useState('7');
  const [title, setTitle] = useState(deliverableTitle);
  const approvers = useQuery({
    queryKey: ['deliverable-approvers', organizationSlug, deliverableId],
    queryFn: () => listApprovers(api, organizationSlug, deliverableId),
  });
  const expiresInDays = Number(days);
  const daysValid = Number.isInteger(expiresInDays) && expiresInDays >= 1 && expiresInDays <= 30;

  const send = useMutation({
    mutationFn: () =>
      createSignatureRequest(api, organizationSlug, {
        deliverableVersionId: version.id,
        signerUserIds: chosen,
        expiresInDays,
        ...(title.trim() === '' ? {} : { title: title.trim() }),
      }),
    onSuccess: (created) => router.push(signatureRequestHref(organizationSlug, created.id)),
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canSend = chosen.length > 0 && daysValid && !send.isPending;

  return (
    <div className="tm-command-palette__backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="tm-card tm-stack tm-esign-sheet"
      >
        <h2 id={titleId} className="tm-heading-2">
          {t('sheetTitle')}
        </h2>
        <p className="tm-field__hint">
          {t('sheetIntro', { version: `v${version.versionNo ?? ''}` })}
        </p>
        <form
          noValidate
          className="tm-stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSend) send.mutate();
          }}
        >
          <Field
            label={t('titleLabel')}
            value={title}
            maxLength={200}
            dir="auto"
            onChange={(event) => setTitle(event.target.value)}
          />
          <fieldset className="tm-esign-fieldset">
            <legend className="tm-field__label">{t('chooseSigners')}</legend>
            {(approvers.data ?? []).map((approver) => (
              <Checkbox
                key={approver.userId}
                label={`${approver.displayName} · ${approver.clientOrganizationName}`}
                checked={chosen.includes(approver.userId)}
                onChange={(event) =>
                  setChosen((current) =>
                    event.target.checked
                      ? [...current, approver.userId]
                      : current.filter((id) => id !== approver.userId),
                  )
                }
              />
            ))}
          </fieldset>
          {approvers.isSuccess && approvers.data.length === 0 ? (
            <InlineAlert tone="warning">{t('noSigners')}</InlineAlert>
          ) : null}
          <Field
            label={t('expiryDays')}
            hint={t('expiryHint')}
            type="number"
            min={1}
            max={30}
            inputMode="numeric"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            {...(daysValid ? {} : { error: t('expiryHint') })}
          />
          {send.isError ? (
            <InlineAlert tone="danger" title={t('sendFailed')} live>
              {describe(send.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-row tm-row--end">
            <Button type="button" tone="outline" size="accessible" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={!canSend}
              loading={send.isPending}
              loadingLabel={t('sending')}
            >
              {t('send')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
