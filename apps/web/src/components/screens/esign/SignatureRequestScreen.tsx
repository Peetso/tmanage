'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Button,
  InlineAlert,
  LoadingRegion,
  Skeleton,
  StateCapsule,
  type CapsuleState,
} from '@tmanage/ui';
import { AppShell } from '../../shell/AppShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  cancelSignatureRequest,
  getSignatureRequest,
  remindSignatureRequest,
  signRefusal,
  type SignatureRequestView,
  type SignatureSignerView,
} from '../../../lib/api/esign';
import { OFFLINE_LINES, useDescribeApiError } from '../../../lib/api/describe-error';
import { shortFingerprint } from '../../../lib/approval-record-presentation';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { Fact } from '../approvals/ApprovalRecordPanel';
import { useEsignT, type EsignKey } from './esign-copy';
import '../../../styles/screens/approval-record.css';
import '../../../styles/screens/esign.css';

export interface SignatureRequestScreenProps {
  organizationSlug: string;
  organizationName: string;
  requestId: string;
  client?: ApiClient;
}

const STATE: Record<SignatureRequestView['state'], { capsule: CapsuleState; key: EsignKey }> = {
  pending: { capsule: 'waiting', key: 'statePending' },
  completed: { capsule: 'done', key: 'stateCompleted' },
  cancelled: { capsule: 'archived', key: 'stateCancelled' },
  expired: { capsule: 'blocked', key: 'stateExpired' },
};

/**
 * **52-26 Signature request (Figma 611:34439 EN / 611:34652 AR)** — who signed, who has only
 * opened the link, and the sealed record of the selected signer. "Opened" is the API's
 * `viewedAt`; the design's "Read to the end" row is not recorded and not shown.
 */
export function SignatureRequestScreen({
  organizationSlug,
  organizationName,
  requestId,
  client,
}: SignatureRequestScreenProps) {
  const t = useEsignT();
  const fmt = useDisplayFormatters();
  const describe = useDescribeApiError(OFFLINE_LINES);
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const queryKey = ['signature-request', organizationSlug, requestId];
  const request = useQuery({
    queryKey,
    queryFn: () => getSignatureRequest(api, organizationSlug, requestId),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const update = (next: SignatureRequestView) => {
    queryClient.setQueryData(queryKey, next);
    void queryClient.invalidateQueries({ queryKey: ['signature-requests', organizationSlug] });
  };
  const cancel = useMutation({
    mutationFn: () => cancelSignatureRequest(api, organizationSlug, requestId),
    onSuccess: update,
  });
  const remind = useMutation({
    mutationFn: () => remindSignatureRequest(api, organizationSlug, requestId),
    onSuccess: update,
  });

  const data = request.data;
  const firstPending = data?.signers.find((signer) => signer.status === 'pending');
  const signedSigners = data?.signers.filter((signer) => signer.record !== null) ?? [];
  const selected =
    signedSigners.find((signer) => signer.id === selectedId) ?? signedSigners[0] ?? null;
  const backHref = data
    ? `/${organizationSlug}/projects/${encodeURIComponent(data.projectId)}/deliverables/${encodeURIComponent(data.deliverableId)}`
    : `/${organizationSlug}/work`;

  const actionError = cancel.error ?? remind.error;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title={data?.title ?? t('panelTitle')}
      eyebrow={
        <Link className="tm-esign-back" href={backHref}>
          {t('backToDeliverable')}
        </Link>
      }
      description={
        data
          ? t('sentOn', { sent: fmt.day(data.createdAt), expires: fmt.day(data.expiresAt) })
          : undefined
      }
      actions={
        data && data.state === 'pending' ? (
          <span className="tm-row tm-row--wrap">
            <Button
              tone="outline"
              size="accessible"
              onClick={() => cancel.mutate()}
              loading={cancel.isPending}
              loadingLabel={t('cancelling')}
            >
              {t('cancelRequest')}
            </Button>
            {firstPending ? (
              <Button
                tone="ink"
                size="accessible"
                onClick={() => remind.mutate()}
                loading={remind.isPending}
                loadingLabel={t('reminding')}
              >
                {t('remind', { name: firstName(firstPending.displayName) })}
              </Button>
            ) : null}
          </span>
        ) : undefined
      }
    >
      <div className="tm-prj tm-prj--sub">
        <div aria-live="polite" className="tm-esign-live">
          {remind.isSuccess ? <p className="tm-esign-muted">{t('reminded')}</p> : null}
        </div>
        {actionError ? (
          <InlineAlert tone="danger" title={t('actionFailed')} live>
            {signRefusal(actionError) === 'rate_limited'
              ? t('remindTooSoon')
              : describe(actionError)}
          </InlineAlert>
        ) : null}
        {request.isError ? (
          <InlineAlert tone="danger" title={t('couldNotOpen')} live>
            {describe(request.error)}
          </InlineAlert>
        ) : request.isPending ? (
          <LoadingRegion label={t('loadingRequest')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : data ? (
          <>
            <div className="tm-row tm-row--wrap">
              <StateCapsule state={data.state === 'pending' ? 'waiting' : 'done'}>
                {t('signedCount', {
                  signed: String(data.signedCount),
                  total: String(data.signers.length),
                })}
              </StateCapsule>
              {data.state !== 'pending' ? (
                <StateCapsule state={STATE[data.state].capsule}>
                  {t(STATE[data.state].key)}
                </StateCapsule>
              ) : null}
            </div>
            <div className="tm-prj__grid tm-prj__grid--aside">
              <div className="tm-prj__col">
                <SignerList
                  signers={data.signers}
                  selectedId={selected?.id ?? null}
                  onSelect={setSelectedId}
                />
              </div>
              <div className="tm-prj__col tm-prj__col--aside">
                <RecordPanel request={data} signer={selected} />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function SignerList({
  signers,
  selectedId,
  onSelect,
}: {
  signers: readonly SignatureSignerView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useEsignT();
  const fmt = useDisplayFormatters();
  const headingId = useId();
  return (
    <section className="tm-card tm-prj-card tm-esign-signers" aria-labelledby={headingId}>
      <div className="tm-arec__head">
        <h2 id={headingId} className="tm-arec__title">
          {t('signers')}
        </h2>
        <span className="tm-arec__muted">{t('anyOrder')}</span>
      </div>
      <ul className="tm-esign-signers__list">
        {signers.map((signer) => {
          const signed = signer.status === 'signed';
          const line =
            signed && signer.signedAt
              ? t('signerSigned', { date: fmt.dateTime(signer.signedAt) })
              : signer.viewedAt
                ? t('signerOpened', { date: fmt.dateTime(signer.viewedAt) })
                : t('signerNotOpened');
          const name = `${signer.displayName} · ${signer.clientOrganizationName}`;
          const person = (
            <>
              <Avatar name={signer.displayName} audience="client" decorative />
              <span className="tm-esign-signer__text">
                <span className="tm-arec__name" dir="auto">
                  {name}
                </span>
                <span className="tm-arec__muted">{line}</span>
              </span>
            </>
          );
          return (
            <li key={signer.id} className="tm-esign-signer">
              {signer.record ? (
                <button
                  type="button"
                  className="tm-esign-signer__pick"
                  aria-pressed={signer.id === selectedId}
                  aria-label={t('showRecord', { name: signer.displayName })}
                  onClick={() => onSelect(signer.id)}
                >
                  {person}
                </button>
              ) : (
                <span className="tm-esign-signer__pick">{person}</span>
              )}
              <StateCapsule state={signed ? 'done' : 'waiting'}>
                {signed ? t('signed') : t('waiting')}
              </StateCapsule>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RecordPanel({
  request,
  signer,
}: {
  request: SignatureRequestView;
  signer: SignatureSignerView | null;
}) {
  const t = useEsignT();
  const fmt = useDisplayFormatters();
  const headingId = useId();
  const record = signer?.record ?? null;
  if (!signer || !record) {
    return (
      <section className="tm-card tm-prj-card tm-arec" aria-labelledby={headingId}>
        <h2 id={headingId} className="tm-arec__title">
          {t('recordTitle', { name: '–' })}
        </h2>
        <p className="tm-arec__muted">{t('recordEmpty')}</p>
      </section>
    );
  }
  const holds = request.documentUnchanged && record.intact;
  const from = [record.ip, record.userAgent].filter(Boolean).join(' · ');
  return (
    <section className="tm-card tm-prj-card tm-arec" aria-labelledby={headingId}>
      <h2 id={headingId} className="tm-arec__title" dir="auto">
        {t('recordTitle', { name: signer.displayName })}
      </h2>
      <Fact label={t('email')}>{record.email}</Fact>
      <Fact label={t('codeChecked')}>{fmt.dateTime(record.codeVerifiedAt)}</Fact>
      <Fact label={t('signedAt')}>{fmt.dateTime(record.signedAt)}</Fact>
      <Fact label={t('signedWith')}>
        {record.method === 'typed'
          ? t('methodTyped', { name: record.typedName ?? '' })
          : t('methodDrawn')}
      </Fact>
      <Fact label={t('signedFrom')}>{from === '' ? t('unknown') : from}</Fact>
      <Fact label={t('fingerprint')} mono>
        {shortFingerprint(record.contentHash)}
      </Fact>
      {holds ? (
        <InlineAlert tone="success" title={t('unchangedTitle')}>
          {t('unchangedBody')}
        </InlineAlert>
      ) : (
        <InlineAlert tone="danger" title={t('mismatchTitle')}>
          {t('mismatchBody')}
        </InlineAlert>
      )}
    </section>
  );
}
