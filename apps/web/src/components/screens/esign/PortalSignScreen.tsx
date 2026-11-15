'use client';

import Link from 'next/link';
import { useCallback, useId, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ClientPortalShell } from '../../shell/ClientPortalShell';
import { browserApiClient } from '../../../lib/api/browser-client';
import type { ApiClient } from '../../../lib/api/client';
import {
  getPortalSignatureRequest,
  sendSignatureCode,
  signRefusal,
  signSignatureRequest,
  type PortalSignatureView,
  type SignatureMethod,
} from '../../../lib/api/esign';
import { usePortalNames } from '../../../lib/use-organization-names';
import { useDisplayFormatters } from '../../../lib/i18n/use-formatters';
import { Segmented, Tag } from '../PortalParts';
import { SignaturePad } from './SignaturePad';
import { useEsignT, type EsignKey } from './esign-copy';
import '../../../styles/screens/esign.css';

export interface PortalSignScreenProps {
  organizationSlug: string;
  clientName: string;
  providerName: string;
  requestId: string;
  client?: ApiClient;
}

const CODE_PATTERN = /^\d{6}$/;

/**
 * **52-26 Sign a document (Figma 610:34405 EN / 610:34601 AR, mobile 610:34521 / 610:34715).**
 *
 * The client reads the document (the existing portal deliverable page), then signs with a typed
 * name or a drawn mark, ticks the consent sentence the API seals into the record, and proves the
 * e-mail with a 6-digit code. The API decides everything; refusals come back as reasons this
 * screen words (states 611:34597 … 611:34651).
 */
export function PortalSignScreen({
  organizationSlug,
  clientName: passedClientName,
  providerName: passedProviderName,
  requestId,
  client,
}: PortalSignScreenProps) {
  const t = useEsignT();
  const { clientName, providerName } = usePortalNames(
    organizationSlug,
    passedClientName,
    passedProviderName,
  );
  const api = client ?? browserApiClient();
  const queryKey = ['portal-signature', organizationSlug, requestId];
  const view = useQuery({
    queryKey,
    queryFn: () => getPortalSignatureRequest(api, organizationSlug, requestId),
    retry: false,
  });
  const data = view.data;
  const agency = data?.organizationName ?? providerName;
  const backHref = `/${organizationSlug}/portal/deliverables`;

  let body: ReactNode;
  if (view.isPending) {
    body = (
      <LoadingRegion label={t('loading')}>
        <Skeleton height="var(--row)" />
        <Skeleton height="calc(var(--row) * 3)" />
      </LoadingRegion>
    );
  } else if (view.isError) {
    body =
      signRefusal(view.error) === 'not_found' ? (
        <StateCard>
          <InlineAlert tone="neutral" title={t('notFoundTitle')}>
            {t('notFoundBody')}
          </InlineAlert>
          <BackLink href={backHref} />
        </StateCard>
      ) : (
        <StateCard>
          <InlineAlert tone="danger" title={t('couldNotOpen')} live>
            {t('couldNotOpenBody')}
          </InlineAlert>
          <button
            type="button"
            className="tm-pt-btn tm-pt-btn--block tm-pt-btn--tall"
            onClick={() => void view.refetch()}
          >
            {t('tryAgain')}
          </button>
        </StateCard>
      );
  } else if (data) {
    body = (
      <SignBody
        api={api}
        organizationSlug={organizationSlug}
        view={data}
        agency={agency}
        backHref={backHref}
        queryKey={queryKey}
      />
    );
  }

  return (
    <ClientPortalShell
      organizationSlug={organizationSlug}
      clientName={clientName}
      providerName={providerName}
      activeNavigationId="deliverables"
      title={data ? t('signTitle', { title: data.title }) : t('yourSignature')}
      eyebrow={
        <Link className="tm-esign-back" href={backHref}>
          {t('backToApprovals')}
        </Link>
      }
      description={data && data.state === 'pending' ? t('askedYouToSign', { agency }) : undefined}
    >
      <div className="tm-pt tm-pt--compact">{body}</div>
    </ClientPortalShell>
  );
}

function StateCard({ children }: { children: ReactNode }) {
  return <section className="tm-pt-card tm-pt-card--lg tm-esign-state">{children}</section>;
}

function BackLink({ href }: { href: string }) {
  const t = useEsignT();
  return (
    <Link className="tm-pt-btn tm-pt-btn--block tm-pt-btn--tall" href={href}>
      {t('backToApprovals')}
    </Link>
  );
}

interface SignBodyProps {
  api: ApiClient;
  organizationSlug: string;
  view: PortalSignatureView;
  agency: string;
  backHref: string;
  queryKey: readonly unknown[];
}

function SignBody({ api, organizationSlug, view, agency, backHref, queryKey }: SignBodyProps) {
  const t = useEsignT();
  const fmt = useDisplayFormatters();
  const queryClient = useQueryClient();
  const [justSigned, setJustSigned] = useState(false);
  const documentHref = `/${organizationSlug}/portal/deliverables/${encodeURIComponent(
    view.deliverableVersionId,
  )}`;
  const openDocument = (
    <Link className="tm-pt-btn tm-pt-btn--block tm-pt-btn--tall" href={documentHref}>
      {t('openDocument')}
    </Link>
  );

  if (view.state === 'signed') {
    const firstName = view.signerName.split(/\s+/)[0] ?? view.signerName;
    const date = view.signedAt ? fmt.dateTime(view.signedAt) : '';
    return justSigned ? (
      <StateCard>
        <div aria-live="polite" className="tm-esign-state__inner">
          <Tag tone="done">✓ {t('signed')}</Tag>
          <h2 className="tm-esign-state__title" dir="auto">
            {t('thankYou', { name: firstName })}
          </h2>
          <p className="tm-esign-muted">{t('signedOn', { date })}</p>
        </div>
        {openDocument}
        <BackLink href={backHref} />
      </StateCard>
    ) : (
      <StateCard>
        <Tag tone="done">✓ {t('alreadySigned')}</Tag>
        <p className="tm-esign-text">{t('alreadySignedBody', { date })}</p>
        {openDocument}
      </StateCard>
    );
  }

  if (view.state === 'expired' || view.state === 'cancelled') {
    const expired = view.state === 'expired';
    return (
      <StateCard>
        <InlineAlert tone="warning" title={t(expired ? 'expiredTitle' : 'cancelledTitle')}>
          {t(expired ? 'expiredBody' : 'cancelledBody', { agency })}
        </InlineAlert>
        <BackLink href={backHref} />
      </StateCard>
    );
  }

  return (
    <div className="tm-esign">
      <section className="tm-pt-card tm-pt-card--lg tm-esign-doc" aria-label={t('documentLabel')}>
        <Tag tone="client">{t('waitingForYou')}</Tag>
        <p className="tm-esign-doc__name" dir="auto">
          <span className="tm-esign-doc__icon" aria-hidden="true" />
          {view.title}
        </p>
        <p className="tm-esign-muted">{t('waitingCard', { date: fmt.dateTime(view.expiresAt) })}</p>
        <Link className="tm-pt-btn" href={documentHref}>
          {t('openDocument')}
        </Link>
      </section>
      <SignForm
        api={api}
        organizationSlug={organizationSlug}
        view={view}
        agency={agency}
        onSigned={(signed) => {
          setJustSigned(true);
          queryClient.setQueryData(queryKey, signed);
        }}
      />
    </div>
  );
}

interface SignFormProps {
  api: ApiClient;
  organizationSlug: string;
  view: PortalSignatureView;
  agency: string;
  onSigned: (signed: PortalSignatureView) => void;
}

/** The "Your signature" panel. Exported for the 52-26 test. */
export function SignForm({ api, organizationSlug, view, agency, onSigned }: SignFormProps) {
  const t = useEsignT();
  const titleId = useId();
  const [mode, setMode] = useState<SignatureMethod>('typed');
  const [typedName, setTypedName] = useState(view.signerName);
  const [mark, setMarkState] = useState<string | null>(null);
  const setMark = useCallback((next: string | null) => setMarkState(next), []);
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [codeAsked, setCodeAsked] = useState(view.codeLive);
  const [emailHint, setEmailHint] = useState(view.emailHint);

  const askCode = useMutation({
    mutationFn: () => sendSignatureCode(api, organizationSlug, view.id),
    onSuccess: (sent) => {
      setCodeAsked(true);
      setEmailHint(sent.emailHint);
      setCode('');
      sign.reset();
    },
  });

  const cleanCode = code.replace(/\s+/g, '');
  const sign = useMutation({
    mutationFn: () =>
      signSignatureRequest(api, organizationSlug, view.id, {
        method: mode,
        ...(mode === 'typed' ? { typedName: typedName.trim() } : { markPng: mark ?? '' }),
        consent: true,
        code: cleanCode,
      }),
    onSuccess: onSigned,
  });

  const refusal = sign.isError ? signRefusal(sign.error) : null;
  const codeExpired = refusal === 'code_expired';
  const hasMark = mode === 'typed' ? typedName.trim() !== '' : mark !== null;
  const canSign =
    consent && CODE_PATTERN.test(cleanCode) && hasMark && codeAsked && !sign.isPending;

  const signError = (): { title: string; body: string } | null => {
    if (!sign.isError || codeExpired) return null;
    const key: EsignKey | null =
      refusal === 'code_wrong'
        ? 'codeWrong'
        : refusal === 'code_locked'
          ? 'codeLocked'
          : refusal === 'code_missing'
            ? 'codeMissing'
            : refusal === 'invalid'
              ? 'signInvalid'
              : refusal === 'document_changed'
                ? 'documentChanged'
                : refusal === 'expired'
                  ? 'expiredBody'
                  : refusal === 'cancelled'
                    ? 'cancelledBody'
                    : null;
    return { title: t('actionFailed'), body: key ? t(key, { agency }) : t('couldNotOpenBody') };
  };
  const failure = signError();
  const askFailure = askCode.isError
    ? signRefusal(askCode.error) === 'rate_limited'
      ? t('codeTooSoon')
      : t('couldNotOpenBody')
    : null;

  return (
    <section className="tm-pt-card tm-pt-card--lg tm-esign-panel" aria-labelledby={titleId}>
      <h2 id={titleId} className="tm-esign-panel__title">
        {t('yourSignature')}
      </h2>
      <form
        className="tm-esign-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canSign) sign.mutate();
        }}
      >
        <Segmented<SignatureMethod>
          label={t('signatureMode')}
          value={mode}
          onChange={(next) => {
            setMode(next);
            sign.reset();
          }}
          options={[
            { id: 'typed', label: t('modeType') },
            { id: 'drawn', label: t('modeDraw') },
          ]}
        />

        {mode === 'typed' ? (
          <>
            <Field
              label={t('fullName')}
              value={typedName}
              maxLength={120}
              autoComplete="name"
              dir="auto"
              onChange={(event) => setTypedName(event.target.value)}
            />
            <div className="tm-esign-preview" aria-hidden="true">
              <span className="tm-esign-muted">{t('preview')}</span>
              <span className="tm-esign-preview__mark" dir="auto">
                {typedName.trim()}
              </span>
            </div>
          </>
        ) : (
          <SignaturePad onChange={setMark} disabled={sign.isPending} />
        )}

        <Checkbox
          label={view.consentText}
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />

        {codeAsked ? (
          codeExpired ? (
            <div className="tm-esign-stack">
              <InlineAlert tone="warning" title={t('codeExpiredTitle')} live>
                {t('codeExpiredBody')}
              </InlineAlert>
              <button
                type="button"
                className="tm-pt-btn tm-pt-btn--ink tm-pt-btn--block tm-pt-btn--tall"
                onClick={() => askCode.mutate()}
                disabled={askCode.isPending}
              >
                {askCode.isPending ? t('sendingCode') : t('sendNewCode')}
              </button>
            </div>
          ) : (
            <>
              <Field
                label={t('codeSentTo', { email: emailHint })}
                value={code}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                dir="ltr"
                className="tm-esign-code"
                onChange={(event) => setCode(event.target.value.replace(/[^\d\s]/g, ''))}
              />
              <button
                type="button"
                className="tm-esign-link"
                onClick={() => askCode.mutate()}
                disabled={askCode.isPending}
              >
                {askCode.isPending ? t('sendingCode') : t('resendCode')}
              </button>
            </>
          )
        ) : (
          <div className="tm-esign-stack">
            <p className="tm-esign-muted">{t('codeWillSendTo', { email: emailHint })}</p>
            <button
              type="button"
              className="tm-pt-btn tm-pt-btn--block tm-pt-btn--tall"
              onClick={() => askCode.mutate()}
              disabled={askCode.isPending}
            >
              {askCode.isPending ? t('sendingCode') : t('sendCode')}
            </button>
          </div>
        )}

        <div aria-live="polite" className="tm-esign-live">
          {askCode.isSuccess && !sign.isError ? (
            <p className="tm-esign-muted">{t('codeSent')}</p>
          ) : null}
        </div>
        {askFailure ? (
          <InlineAlert tone="warning" live>
            {askFailure}
          </InlineAlert>
        ) : null}
        {failure ? (
          <InlineAlert tone="danger" title={failure.title} live>
            {failure.body}
          </InlineAlert>
        ) : null}

        <button
          type="submit"
          className="tm-pt-btn tm-pt-btn--ink tm-pt-btn--block tm-pt-btn--tall"
          disabled={!canSign}
          aria-busy={sign.isPending || undefined}
        >
          {sign.isPending ? t('signing') : t('signDocument')}
        </button>
        <p className="tm-esign-muted">{t('footer', { agency })}</p>
      </form>
    </section>
  );
}
