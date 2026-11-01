'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { Dialog, errorMessage } from './SecurityScreen';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  beginTotpEnrolment,
  confirmTotpEnrolment,
  disableFactor,
  listFactors,
} from '../../lib/api/auth';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { qrModules, qrPath } from '../../lib/qr-code';
import '../../styles/screens/access-security.css';

export interface TwoStepSignInScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** A11: the person was sent here because their company requires two-step sign-in. */
  required?: boolean;
}

type Enrolment = { factorId: string; secret: string; uri: string };
type Action =
  { kind: 'begin' } | { kind: 'confirm'; code: string } | { kind: 'disable'; factorId: string };

/** The header the five credential-changing routes read the step-up proof from (`D05`). */
const REAUTH_HEADER = 'x-reauth-token';

/**
 * **Two-step sign-in (t2-c) — turn on an authenticator app, save the recovery codes, or turn it off.**
 *
 * With no confirmed factor the screen starts an enrolment at once: the `otpauth://` URI drawn as a
 * QR (encoded in the browser — the secret never leaves it), the key to type by hand, and the
 * 6-digit confirm. The recovery codes come back exactly once and are shown with copy and download.
 * A `403 reauthentication_required` opens the step-up form (password, and code when a factor is
 * already on); the proof it returns is sent as `x-reauth-token` on the retried action.
 */
export function TwoStepSignInScreen({
  organizationSlug,
  organizationName,
  client,
  required = false,
}: TwoStepSignInScreenProps) {
  const t = useT();
  const tOr = useTOr();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const factorsKey = ['auth-factors'] as const;
  const factors = useQuery({ queryKey: factorsKey, queryFn: () => listFactors(api) });

  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [stepUp, setStepUp] = useState<Action | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<string | null>(null);
  const reauthToken = useRef<string | null>(null);
  const started = useRef(false);

  const run = useMutation({
    mutationFn: async (action: Action): Promise<void> => {
      const headers = reauthToken.current ? { [REAUTH_HEADER]: reauthToken.current } : undefined;
      try {
        if (action.kind === 'begin') {
          const label = t('TwoStep.factorLabel');
          setEnrolment(
            headers
              ? (
                  await api.request<Enrolment>({
                    method: 'POST',
                    path: '/v1/auth/factors/totp',
                    body: { label },
                    headers,
                  })
                ).data
              : await beginTotpEnrolment(api, { label }),
          );
        } else if (action.kind === 'confirm') {
          if (!enrolment) return;
          const input = { factorId: enrolment.factorId, code: action.code };
          const result = headers
            ? (
                await api.request<{ recoveryCodes: readonly string[] }>({
                  method: 'POST',
                  path: '/v1/auth/factors/totp/confirm',
                  body: input,
                  headers,
                })
              ).data
            : await confirmTotpEnrolment(api, input);
          setRecoveryCodes(result.recoveryCodes);
          setEnrolment(null);
          void queries.invalidateQueries({ queryKey: factorsKey });
        } else {
          if (headers) {
            await api.request<void>({
              method: 'DELETE',
              path: `/v1/auth/factors/${encodeURIComponent(action.factorId)}`,
              headers,
            });
          } else {
            await disableFactor(api, action.factorId);
          }
          setConfirmDisable(null);
          started.current = false;
          void queries.invalidateQueries({ queryKey: factorsKey });
        }
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
          reauthToken.current = null;
          setConfirmDisable(null);
          setStepUp(action);
          return;
        }
        throw error;
      }
    },
  });

  const confirmed = factors.data?.factors.find(
    (factor) => factor.kind === 'totp' && factor.confirmedAt !== null,
  );

  useEffect(() => {
    if (!factors.isSuccess || confirmed || recoveryCodes || started.current) return;
    started.current = true;
    run.mutate({ kind: 'begin' });
  }, [factors.isSuccess, confirmed, recoveryCodes, run]);

  // Back to Preferences, where the Two-step sign-in row that opened this page lives.
  const securityHref = `/${organizationSlug}/preferences`;

  let body;
  if (factors.isPending) {
    body = (
      <LoadingRegion label={t('TwoStep.loading')}>
        <Skeleton />
      </LoadingRegion>
    );
  } else if (factors.isError) {
    body = (
      <InlineAlert tone="danger" title={t('TwoStep.loadError')}>
        {errorMessage(factors.error)}
      </InlineAlert>
    );
  } else if (stepUp) {
    body = (
      <StepUpCard
        api={api}
        needsCode={confirmed !== undefined}
        cancelHref={securityHref}
        onConfirmed={(token) => {
          reauthToken.current = token;
          const action = stepUp;
          setStepUp(null);
          run.mutate(action);
        }}
      />
    );
  } else if (recoveryCodes) {
    body = <RecoveryCodesCard codes={recoveryCodes} doneHref={securityHref} />;
  } else if (confirmed) {
    body = (
      <section className="tm-sec-card tm-sec-card--dialog" aria-labelledby="tm-2s-on">
        <h2 id="tm-2s-on" className="tm-sec-card__title">
          {t('TwoStep.onTitle')}
        </h2>
        <p className="tm-sec-card__body">{t('TwoStep.onBody')}</p>
        <div className="tm-sec-actions">
          <Button tone="outline" onClick={() => setConfirmDisable(confirmed.id)}>
            {t('TwoStep.disable')}
          </Button>
        </div>
      </section>
    );
  } else if (enrolment) {
    body = (
      <EnrolCard
        enrolment={enrolment}
        cancelHref={securityHref}
        verifying={run.isPending}
        error={run.isError ? errorMessage(run.error) : null}
        onVerify={(code) => run.mutate({ kind: 'confirm', code })}
      />
    );
  } else if (run.isError) {
    body = (
      <InlineAlert tone="danger" title={t('TwoStep.startError')}>
        {errorMessage(run.error)}
      </InlineAlert>
    );
  } else {
    body = (
      <LoadingRegion label={t('TwoStep.starting')}>
        <Skeleton />
      </LoadingRegion>
    );
  }

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      eyebrow={t('TwoStep.eyebrow')}
      title={t('TwoStep.pageTitle')}
    >
      <div className="tm-sec">
        {required && !twoStepOnNow(factors.data) ? (
          <InlineAlert
            tone="warning"
            title={tOr('TwoStep.requiredTitle', 'Your company requires two-step sign-in')}
          >
            {tOr('TwoStep.requiredBody', 'Turn it on below to keep using TManage.')}
          </InlineAlert>
        ) : null}
        {body}
      </div>
      {confirmDisable ? (
        <Dialog title={t('TwoStep.confirmDisableTitle')} onClose={() => setConfirmDisable(null)}>
          <p className="tm-sec-card__body">{t('TwoStep.confirmDisableBody')}</p>
          {run.isError ? (
            <InlineAlert tone="danger" title={t('TwoStep.disableError')} live>
              {errorMessage(run.error)}
            </InlineAlert>
          ) : null}
          <div className="tm-sec-actions">
            <Button tone="outline" onClick={() => setConfirmDisable(null)}>
              {t('TwoStep.cancel')}
            </Button>
            <Button
              tone="destructive"
              loading={run.isPending}
              loadingLabel={t('TwoStep.disabling')}
              onClick={() => run.mutate({ kind: 'disable', factorId: confirmDisable })}
            >
              {t('TwoStep.disable')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </AppShell>
  );
}

/** "K7QX2M4P…" → "K7QX 2M4P …", the grouping the design shows. */
export function groupKey(secret: string): string {
  return secret.replace(/\s+/gu, '').replace(/(.{4})(?=.)/gu, '$1 ');
}

function EnrolCard({
  enrolment,
  cancelHref,
  verifying,
  error,
  onVerify,
}: {
  enrolment: Enrolment;
  cancelHref: string;
  verifying: boolean;
  error: string | null;
  onVerify: (code: string) => void;
}) {
  const t = useT();
  const keyId = useId();
  const codeId = useId();
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const modules = useMemo(() => qrModules(enrolment.uri), [enrolment.uri]);
  const viewBox = modules.length + 8;
  const digits = code.replace(/\D/gu, '');

  return (
    <form
      className="tm-sec-card tm-sec-card--dialog"
      aria-labelledby="tm-2s-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (digits.length === 6) onVerify(digits);
      }}
    >
      <h2 id="tm-2s-title" className="tm-sec-card__title">
        {t('TwoStep.title')}
      </h2>
      <p className="tm-sec-card__body">{t('TwoStep.scanBody')}</p>
      <div className="tm-sec-qr" dir="ltr">
        <svg
          viewBox={`0 0 ${viewBox} ${viewBox}`}
          role="img"
          aria-label={t('TwoStep.qrLabel')}
          shapeRendering="crispEdges"
          data-testid="tm-2s-qr"
        >
          <path d={qrPath(modules)} fill="currentColor" />
        </svg>
      </div>
      <div className="tm-sec-field">
        <label className="tm-sec-field__label" htmlFor={keyId}>
          {t('TwoStep.manualLabel')}
        </label>
        <div className="tm-sec-field__row">
          <input
            id={keyId}
            className="tm-sec-input tm-sec-input--readout"
            dir="ltr"
            readOnly
            value={groupKey(enrolment.secret)}
          />
          <Button
            tone="outline"
            size="feature"
            onClick={() => {
              void navigator.clipboard?.writeText(enrolment.secret).then(() => setCopied(true));
            }}
          >
            {copied ? t('TwoStep.copied') : t('TwoStep.copy')}
          </Button>
        </div>
      </div>
      <div className="tm-sec-field">
        <label className="tm-sec-field__label" htmlFor={codeId}>
          {t('TwoStep.codeLabel')}
        </label>
        <input
          id={codeId}
          className="tm-sec-input"
          dir="ltr"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
      </div>
      {error ? (
        <InlineAlert tone="danger" title={t('TwoStep.verifyError')} live>
          {error}
        </InlineAlert>
      ) : null}
      <InlineAlert tone="neutral">{t('TwoStep.recoveryNote')}</InlineAlert>
      <div className="tm-sec-actions">
        <Link className="tm-button tm-button--outline tm-button--feature" href={cancelHref}>
          {t('TwoStep.cancel')}
        </Link>
        <Button
          tone="ink"
          size="feature"
          type="submit"
          disabled={digits.length !== 6}
          loading={verifying}
          loadingLabel={t('TwoStep.verifying')}
        >
          {t('TwoStep.verify')}
        </Button>
      </div>
    </form>
  );
}

function RecoveryCodesCard({ codes, doneHref }: { codes: readonly string[]; doneHref: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <section className="tm-sec-card tm-sec-card--dialog" aria-labelledby="tm-2s-codes">
      <h2 id="tm-2s-codes" className="tm-sec-card__title">
        {t('TwoStep.codesTitle')}
      </h2>
      <p className="tm-sec-card__body">{t('TwoStep.codesBody')}</p>
      <ul className="tm-sec-codes" dir="ltr" data-testid="tm-2s-codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="tm-sec-actions">
        <Button
          tone="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? t('TwoStep.copied') : t('TwoStep.copyCodes')}
        </Button>
        <Button
          tone="outline"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'tmanage-recovery-codes.txt';
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          {t('TwoStep.downloadCodes')}
        </Button>
        <Link className="tm-button tm-button--ink tm-button--default" href={doneHref}>
          {t('TwoStep.done')}
        </Link>
      </div>
    </section>
  );
}

function StepUpCard({
  api,
  needsCode,
  cancelHref,
  onConfirmed,
}: {
  api: ApiClient;
  needsCode: boolean;
  cancelHref: string;
  onConfirmed: (token: string) => void;
}) {
  const t = useT();
  const passwordId = useId();
  const codeId = useId();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const confirm = useMutation({
    mutationFn: async () =>
      (
        await api.request<{ reauthToken: string }>({
          method: 'POST',
          path: '/v1/auth/reauth',
          body: needsCode ? { password, code: code.replace(/\D/gu, '') } : { password },
        })
      ).data,
    onSuccess: (data) => onConfirmed(data.reauthToken),
  });
  return (
    <form
      className="tm-sec-card tm-sec-card--dialog"
      aria-labelledby="tm-2s-stepup"
      onSubmit={(event) => {
        event.preventDefault();
        confirm.mutate();
      }}
    >
      <h2 id="tm-2s-stepup" className="tm-sec-card__title">
        {t('TwoStep.reauthTitle')}
      </h2>
      <p className="tm-sec-card__body">{t('TwoStep.reauthBody')}</p>
      <div className="tm-sec-field">
        <label className="tm-sec-field__label" htmlFor={passwordId}>
          {t('TwoStep.passwordLabel')}
        </label>
        <input
          id={passwordId}
          className="tm-sec-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {needsCode ? (
        <div className="tm-sec-field">
          <label className="tm-sec-field__label" htmlFor={codeId}>
            {t('TwoStep.reauthCodeLabel')}
          </label>
          <input
            id={codeId}
            className="tm-sec-input"
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
        </div>
      ) : null}
      {confirm.isError ? (
        <InlineAlert tone="danger" title={t('TwoStep.reauthError')} live>
          {errorMessage(confirm.error)}
        </InlineAlert>
      ) : null}
      <div className="tm-sec-actions">
        <Link className="tm-button tm-button--outline tm-button--feature" href={cancelHref}>
          {t('TwoStep.cancel')}
        </Link>
        <Button
          tone="ink"
          size="feature"
          type="submit"
          disabled={password === ''}
          loading={confirm.isPending}
          loadingLabel={t('TwoStep.verifying')}
        >
          {t('TwoStep.reauthSubmit')}
        </Button>
      </div>
    </form>
  );
}

/** Whether a confirmed factor is already on — the required notice is hidden once it is. */
function twoStepOnNow(
  data: { readonly factors?: readonly { confirmedAt: string | null }[] } | undefined,
): boolean {
  return Array.isArray(data?.factors) && data.factors.some((factor) => factor.confirmedAt !== null);
}
