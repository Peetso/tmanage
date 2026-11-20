'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { SettingsShell } from '../admin/SettingsShell';
import { Dialog, errorMessage } from './SecurityScreen';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  beginEmailFactor,
  beginTotpEnrolment,
  confirmEmailFactor,
  confirmTotpEnrolment,
  disableFactor,
  listFactors,
  regenerateRecoveryCodes,
  setDefaultFactor,
  type EnrolledFactor,
  type FactorsView,
} from '../../lib/api/auth';
import { ApiRequestError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { qrModules, qrPath } from '../../lib/qr-code';
import { SixDigitCode } from './SixDigitCode';
import { ConfirmEmailNotice } from './ConfirmEmailNotice';
import '../../styles/screens/access-security.css';

export interface TwoStepSignInScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
  /** A11: the person was sent here because their company requires two-step sign-in. */
  required?: boolean;
}

type Enrolment = { factorId: string; secret: string; uri: string };
type EmailEnrolment = { factorId: string; sentTo: string; resendAt: number };
type Action =
  | { kind: 'begin' }
  | { kind: 'confirm'; code: string }
  | { kind: 'disable'; factorId: string }
  | { kind: 'beginEmail' }
  | { kind: 'confirmEmail'; code: string }
  | { kind: 'makeDefault'; factorId: string }
  | { kind: 'newCodes' };

/** One action button on a method row. */
interface RowAction {
  readonly label: string;
  readonly action: Action;
  readonly primary?: boolean;
  readonly disabled?: boolean;
}

/** The header the credential-changing routes read the step-up proof from (`D05`). */
const REAUTH_HEADER = 'x-reauth-token';

/**
 * **Two-step verification (t2-c, MFAOPTIONS) — the ways to confirm it's you.**
 *
 * A short list of methods, each with one plain line and its state: the authenticator app, e-mail
 * codes (to the account's verified address) and backup codes. No text messages: that is a paid
 * service. The person picks the default — the method a sign-in asks for first. Turning a method on
 * or off, choosing the default and new backup codes all need the password again: a `403
 * reauthentication_required` opens the step-up form, and its proof is sent as `x-reauth-token` on
 * the retried action. The server decides what is allowed; this screen only asks.
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
  const [emailEnrolment, setEmailEnrolment] = useState<EmailEnrolment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [stepUp, setStepUp] = useState<Action | null>(null);
  const [confirmDisable, setConfirmDisable] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reauthToken = useRef<string | null>(null);

  const run = useMutation({
    mutationFn: async (action: Action): Promise<void> => {
      const headers = reauthToken.current ? { [REAUTH_HEADER]: reauthToken.current } : undefined;
      const proof = reauthToken.current ?? undefined;
      setNotice(null);
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
        } else if (action.kind === 'disable') {
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
          void queries.invalidateQueries({ queryKey: factorsKey });
        } else if (action.kind === 'beginEmail') {
          const sent = await beginEmailFactor(api, proof);
          setEmailEnrolment({
            factorId: sent.factorId,
            sentTo: sent.sentTo,
            resendAt: Date.now() + sent.resendAfterSeconds * 1000,
          });
        } else if (action.kind === 'confirmEmail') {
          if (!emailEnrolment) return;
          const result = await confirmEmailFactor(
            api,
            { factorId: emailEnrolment.factorId, code: action.code },
            proof,
          );
          setEmailEnrolment(null);
          if (result.recoveryCodes.length > 0) setRecoveryCodes(result.recoveryCodes);
          else setNotice(t('TwoStep.emailOnNotice'));
          void queries.invalidateQueries({ queryKey: factorsKey });
        } else if (action.kind === 'makeDefault') {
          await setDefaultFactor(api, action.factorId, proof);
          setNotice(t('TwoStep.defaultNotice'));
          void queries.invalidateQueries({ queryKey: factorsKey });
        } else {
          const result = headers
            ? (
                await api.request<{ recoveryCodes: readonly string[] }>({
                  method: 'POST',
                  path: '/v1/auth/recovery-codes',
                  headers,
                })
              ).data
            : await regenerateRecoveryCodes(api);
          setRecoveryCodes(result.recoveryCodes);
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

  const view = factors.data;
  // Back to Preferences, where the Two-step sign-in row that opened this page lives.
  const securityHref = `/${organizationSlug}/preferences`;

  let body;
  if (factors.isPending) {
    body = (
      <LoadingRegion label={t('TwoStep.loading')}>
        <Skeleton />
      </LoadingRegion>
    );
  } else if (factors.isError || view === undefined) {
    body = (
      <InlineAlert tone="danger" title={t('TwoStep.loadError')}>
        {errorMessage(factors.error)}
      </InlineAlert>
    );
  } else if (stepUp) {
    body = (
      <StepUpCard
        api={api}
        needsCode={view.reauthNeedsAuthenticatorCode}
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
  } else if (emailEnrolment) {
    body = (
      <EmailEnrolCard
        enrolment={emailEnrolment}
        working={run.isPending}
        error={run.isError ? errorMessage(run.error) : null}
        onCancel={() => setEmailEnrolment(null)}
        onResend={() => run.mutate({ kind: 'beginEmail' })}
        onVerify={(code) => run.mutate({ kind: 'confirmEmail', code })}
      />
    );
  } else {
    body = (
      <MethodsCard
        view={view}
        working={run.isPending}
        error={run.isError ? errorMessage(run.error) : null}
        notice={notice}
        onAction={(action) => {
          if (action.kind === 'disable') setConfirmDisable(action.factorId);
          else run.mutate(action);
        }}
      />
    );
  }

  return (
    <SettingsShell
      section="two-step"
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
        {view && !view.email.verified ? <ConfirmEmailNotice api={api} /> : null}
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
    </SettingsShell>
  );
}

/** The actions on a live method's row: "Make default" when there is a choice, and "Turn off". */
function liveActions(
  factor: EnrolledFactor,
  choice: boolean,
  labels: { makeDefault: string; turnOff: string },
): readonly RowAction[] {
  const off: RowAction = {
    label: labels.turnOff,
    action: { kind: 'disable', factorId: factor.id },
  };
  if (!choice || factor.isDefault) return [off];
  return [{ label: labels.makeDefault, action: { kind: 'makeDefault', factorId: factor.id } }, off];
}

/**
 * The list of methods (design frame "Ways to confirm it's you"): one row per method, a plain line,
 * its On / Off / Default state and the action that changes it. Backup codes are always listed;
 * they exist only while another method is on.
 */
function MethodsCard({
  view,
  working,
  error,
  notice,
  onAction,
}: {
  view: FactorsView;
  working: boolean;
  error: string | null;
  notice: string | null;
  onAction: (action: Action) => void;
}) {
  const t = useT();
  const live = (kind: string): EnrolledFactor | undefined =>
    view.factors.find((factor) => factor.kind === kind && factor.confirmedAt !== null);
  const app = live('totp');
  const email = live('email');
  const anyOn = app !== undefined || email !== undefined;
  const choice = app !== undefined && email !== undefined;
  const labels = { makeDefault: t('TwoStep.makeDefault'), turnOff: t('TwoStep.disable') };

  const rows: readonly {
    readonly key: string;
    readonly name: string;
    readonly line: string;
    readonly factor: EnrolledFactor | undefined;
    readonly actions: readonly RowAction[];
  }[] = [
    {
      key: 'totp',
      name: t('TwoStep.appName'),
      line: t('TwoStep.appLine'),
      factor: app,
      actions: app
        ? liveActions(app, choice, labels)
        : [{ label: t('TwoStep.turnOn'), action: { kind: 'begin' }, primary: true }],
    },
    {
      key: 'email',
      name: t('TwoStep.emailName'),
      line: view.email.verified
        ? t('TwoStep.emailLine').replace('{address}', isolate(view.email.address))
        : t('TwoStep.emailUnverified'),
      factor: email,
      actions: email
        ? liveActions(email, choice, labels)
        : [
            {
              label: t('TwoStep.turnOn'),
              action: { kind: 'beginEmail' },
              primary: true,
              disabled: !view.email.verified,
            },
          ],
    },
  ];

  return (
    <section className="tm-sec-card tm-sec-card--dialog" aria-labelledby="tm-2s-methods">
      <h2 id="tm-2s-methods" className="tm-sec-card__title">
        {t('TwoStep.methodsTitle')}
      </h2>
      <p className="tm-sec-card__body">{t('TwoStep.methodsBody')}</p>
      {notice ? (
        <InlineAlert tone="success" live>
          {notice}
        </InlineAlert>
      ) : null}
      {error ? (
        <InlineAlert tone="danger" title={t('TwoStep.changeError')} live>
          {error}
        </InlineAlert>
      ) : null}
      <ul className="tm-sec-methods">
        {rows.map((row) => (
          <li key={row.key} className="tm-sec-method">
            <div className="tm-sec-method__text">
              <span className="tm-sec-method__name">{row.name}</span>
              <span className="tm-sec-method__line">{row.line}</span>
            </div>
            <div className="tm-sec-method__state">
              <StatePill on={row.factor !== undefined} />
              {row.factor && (row.factor.isDefault || !choice) ? (
                <span className="tm-sec-pill tm-sec-pill--default">{t('TwoStep.default')}</span>
              ) : null}
            </div>
            <div className="tm-sec-method__actions">
              {row.actions.map((item) => (
                <Button
                  key={item.label}
                  tone={item.primary ? 'ink' : 'outline'}
                  size="feature"
                  disabled={working || item.disabled === true}
                  aria-label={`${item.label} · ${row.name}`}
                  onClick={() => onAction(item.action)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </li>
        ))}
        <li className="tm-sec-method">
          <div className="tm-sec-method__text">
            <span className="tm-sec-method__name">{t('TwoStep.backupName')}</span>
            <span className="tm-sec-method__line">
              {anyOn
                ? t('TwoStep.backupLine').replace('{count}', String(view.recoveryCodesRemaining))
                : t('TwoStep.backupOff')}
            </span>
          </div>
          <div className="tm-sec-method__state">
            <StatePill on={anyOn} />
          </div>
          <div className="tm-sec-method__actions">
            {anyOn ? (
              <Button
                tone="outline"
                size="feature"
                disabled={working}
                aria-label={`${t('TwoStep.newCodes')} · ${t('TwoStep.backupName')}`}
                onClick={() => onAction({ kind: 'newCodes' })}
              >
                {t('TwoStep.newCodes')}
              </Button>
            ) : null}
          </div>
        </li>
      </ul>
      <p className="tm-sec-methods__note">{t('TwoStep.methodsNote')}</p>
    </section>
  );
}

/** Turning e-mail codes on: the code mailed to the verified address, typed back once. */
function EmailEnrolCard({
  enrolment,
  working,
  error,
  onCancel,
  onResend,
  onVerify,
}: {
  enrolment: EmailEnrolment;
  working: boolean;
  error: string | null;
  onCancel: () => void;
  onResend: () => void;
  onVerify: (code: string) => void;
}) {
  const t = useT();
  const codeId = useId();
  const [code, setCode] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const digits = code.replace(/\D/gu, '');
  const wait = Math.max(0, Math.ceil((enrolment.resendAt - now) / 1000));

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enrolment.resendAt]);

  return (
    <form
      className="tm-sec-card tm-sec-card--dialog"
      aria-labelledby="tm-2s-email"
      onSubmit={(event) => {
        event.preventDefault();
        if (digits.length === 6) onVerify(digits);
      }}
    >
      <h2 id="tm-2s-email" className="tm-sec-card__title">
        {t('TwoStep.emailTitle')}
      </h2>
      <p className="tm-sec-card__body" aria-live="polite">
        {t('TwoStep.emailSent').replace('{address}', isolate(enrolment.sentTo))}
      </p>
      <div className="tm-sec-field">
        <label className="tm-sec-field__label" htmlFor={codeId}>
          {t('TwoStep.codeLabel')}
        </label>
        <SixDigitCode id={codeId} value={code} onChange={setCode} />
      </div>
      {error ? (
        <InlineAlert tone="danger" title={t('TwoStep.verifyError')} live>
          {error}
        </InlineAlert>
      ) : null}
      <div className="tm-sec-actions tm-sec-actions--code">
        <Button
          tone="ink"
          size="feature"
          type="submit"
          disabled={digits.length !== 6}
          loading={working}
          loadingLabel={t('TwoStep.verifying')}
        >
          {t('TwoStep.emailVerify')}
        </Button>
        {wait > 0 ? (
          <span className="tm-sec-resend" aria-live="polite">
            {t('TwoStep.resendIn').replace('{time}', clock(wait))}
          </span>
        ) : (
          <button
            type="button"
            className="tm-sec-resend tm-sec-resend--action"
            disabled={working}
            onClick={onResend}
          >
            {t('TwoStep.resend')}
          </button>
        )}
        <Button tone="outline" size="feature" className="tm-sec-actions__end" onClick={onCancel}>
          {t('TwoStep.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** "On" / "Off": the check glyph carries the state too, so it is never colour alone. */
function StatePill({ on }: { on: boolean }) {
  const t = useT();
  return (
    <span className={on ? 'tm-sec-pill tm-sec-pill--on' : 'tm-sec-pill'}>
      {on ? (
        <span className="tm-sec-pill__glyph" aria-hidden="true">
          ✓
        </span>
      ) : null}
      {on ? t('TwoStep.on') : t('TwoStep.off')}
    </span>
  );
}

/** A Latin address inside a sentence, isolated so an Arabic sentence keeps its punctuation. */
function isolate(text: string): string {
  return `⁨${text}⁩`;
}

/** `24` → `0:24`. */
function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
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
