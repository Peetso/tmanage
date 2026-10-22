'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Checkbox, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import { completePasswordReset, requestPasswordReset } from '../../lib/api/password-reset';
import '../../styles/screens/identity.css';

/** The states the export draws for recovery (`22` §3 ID-05), plus choosing the new password. */
export type RecoveryState = 'request' | 'sent' | 'reset' | 'expired' | 'completed';

export interface RecoveryScreenProps {
  /**
   * The state to start in — for design review. `/recover` passes nothing, so a URL can never
   * start this screen in an outcome state (D15); `sent`, `completed` and `expired` are reached at
   * run time only from the API's answer.
   */
  state?: RecoveryState;
  /** From `/recover/[token]` — the emailed link. Starts the screen in `reset`. Never rendered. */
  token?: string;
  client?: ApiClient;
  /** Where a saved password goes next — `/sign-in`. Tests pass a spy; the app does a full load. */
  navigate?: (href: string) => void;
}

/** `PASSWORD_MIN_LENGTH` in `apps/api/src/modules/identity/password.ts`. */
const MIN_PASSWORD = 8;

/**
 * **ID-05 Session and recovery** — the recovery half, now working (ACC-02).
 *
 * request → (email) → sent; the emailed link opens `reset` → completed, or expired when the
 * link is used, superseded or out of time.
 *
 * ## The rule that shapes every word here
 *
 * The "sent" state says *"If an account exists for that address, a link is on its way."* A
 * recovery form that confirms an address is known is an account-enumeration oracle
 * (`26-THREAT-MODELS`), so the API answers identically for known and unknown addresses and the
 * copy says so plainly.
 *
 * The "expired" state refuses to extend the link. Extending a recovery link on request turns a
 * 30-minute window into an indefinite one for anyone who can reach the inbox later.
 *
 * ## D15
 *
 * `/recover` passes no `state`, and `/recover/[token]` passes only the token, so the outcome
 * states (`sent`, `completed`, `expired`) are reached only from a real API answer — a query
 * string cannot make this screen claim an email was sent or a password changed.
 */
export function RecoveryScreen({
  state: initial,
  token,
  client,
  navigate = (href) => window.location.assign(href),
}: RecoveryScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  /** Keys added in wave P2 (`Recovery.*`), merged into the catalogs by the committer. */
  const tr = (key: string) => t(key as MessageKey);
  const describe = (error: unknown) => describeFailure(error, tr);
  const adminFallback = t('RecoveryScreen.adminFallback');
  const [state, setState] = useState<RecoveryState>(
    initial ?? (token === undefined ? 'request' : 'reset'),
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(undefined);
    setBusy(true);
    try {
      await requestPasswordReset(api, email.trim());
      setState('sent');
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function choosePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token === undefined) return;
    setFailure(undefined);
    setPasswordError(undefined);
    setConfirmError(undefined);
    if (password.length < MIN_PASSWORD) {
      setPasswordError(
        `${tr('Recovery.tooShortPrefix')}${MIN_PASSWORD}${tr('Recovery.tooShortSuffix')}`,
      );
      return;
    }
    if (confirmation !== password) {
      setConfirmError(tr('Recovery.mismatch'));
      return;
    }
    setBusy(true);
    try {
      await completePasswordReset(api, token, password);
      setPassword('');
      setConfirmation('');
      navigate('/sign-in');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setPassword('');
        setConfirmation('');
        setState('expired');
      } else if (error instanceof ApiRequestError && error.status === 422) {
        setPasswordError(error.fieldErrors().get('password') ?? error.message);
      } else {
        setFailure(describe(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <IdentityShell
      screenId="ID-05"
      eyebrow={t('RecoveryScreen.eyebrow')}
      footer={<Link href="/sign-in">{t('RecoveryScreen.backToSignIn')}</Link>}
    >
      {state === 'request' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--ink">
            <span className="tm-id-step tm-id-step--ink">{t('RecoveryScreen.stepRequest')}</span>
            <h1 className="tm-id-card__title">{t('RecoveryScreen.recoverAccess')}</h1>
            <p className="tm-id-card__body">{t('RecoveryScreen.requestBody')}</p>
            <form
              className="tm-stack tm-stack--tight"
              noValidate
              onSubmit={(event) => void sendLink(event)}
            >
              <Field
                label={t('RecoveryScreen.workEmail')}
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                dir="ltr"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={busy}
              />
              {failure ? (
                <InlineAlert tone="danger" title={t('RecoveryScreen.didNotGoThrough')} live>
                  {failure}
                </InlineAlert>
              ) : null}
              <div className="tm-id-action-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={busy}
                  loadingLabel={t('RecoveryScreen.sending')}
                  disabled={email.trim() === ''}
                >
                  {t('RecoveryScreen.sendLink')}
                </Button>
              </div>
            </form>
          </section>
          <p className="tm-id-card__body">{adminFallback}</p>
        </div>
      ) : null}

      {state === 'sent' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card">
            <span className="tm-id-step">{t('RecoveryScreen.stepSent')}</span>
            <h1 className="tm-id-card__title">{t('RecoveryScreen.checkEmail')}</h1>
            <InlineAlert tone="neutral" title={t('RecoveryScreen.linkMaybeTitle')}>
              {t('RecoveryScreen.sentBody')}
            </InlineAlert>
            <p className="tm-id-card__body">{t('RecoveryScreen.sentExplain')}</p>
          </section>
          <p className="tm-id-card__body">{adminFallback}</p>
        </div>
      ) : null}

      {state === 'reset' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card">
            <h1 className="tm-id-card__title">{t('RecoveryScreen.chooseNewPassword')}</h1>
            <p className="tm-id-card__body">{tr('Recovery.linkNote')}</p>
            <form
              className="tm-stack tm-stack--tight"
              noValidate
              onSubmit={(event) => void choosePassword(event)}
            >
              <Field
                label={t('RecoveryScreen.newPassword')}
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                hint={`${t('RecoveryScreen.passwordHintPrefix')}${MIN_PASSWORD}${tr('Recovery.passwordHintSuffix')}`}
                required
                disabled={busy}
                {...(passwordError ? { error: passwordError } : {})}
              />
              <Field
                label={tr('Recovery.confirmPassword')}
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                disabled={busy}
                {...(confirmError ? { error: confirmError } : {})}
              />
              <Checkbox label={tr('Recovery.signOutOthers')} checked readOnly disabled />
              {failure ? (
                <InlineAlert tone="danger" title={t('RecoveryScreen.didNotGoThrough')} live>
                  {failure}
                </InlineAlert>
              ) : null}
              <div className="tm-id-action-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={busy}
                  loadingLabel={t('RecoveryScreen.saving')}
                  style={{ flex: 'none' }}
                >
                  {tr('Recovery.saveAndSignIn')}
                </Button>
                <Link
                  className="tm-button tm-button--text tm-button--accessible"
                  href="/sign-in"
                  style={{ flex: 'none' }}
                >
                  {t('RecoveryScreen.backToSignIn')}
                </Link>
              </div>
            </form>
            <InlineAlert tone="neutral">{tr('Recovery.expiredHint')}</InlineAlert>
          </section>
        </div>
      ) : null}

      {state === 'expired' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--warning">
            <span className="tm-id-step tm-id-step--warning">
              {t('RecoveryScreen.stepExpired')}
            </span>
            <h1 className="tm-id-card__title">{t('RecoveryScreen.linkExpired')}</h1>
            <p className="tm-id-card__body">{t('RecoveryScreen.expiredBody')}</p>
            <div className="tm-id-action-row">
              <Button
                tone="ink"
                size="accessible"
                onClick={() => {
                  setFailure(undefined);
                  setState('request');
                }}
              >
                {t('RecoveryScreen.requestNewLink')}
              </Button>
            </div>
          </section>
          <p className="tm-id-card__body">{adminFallback}</p>
        </div>
      ) : null}

      {state === 'completed' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--success">
            <span className="tm-id-step tm-id-step--success">
              {t('RecoveryScreen.stepCompleted')}
            </span>
            <h1 className="tm-id-card__title">{t('RecoveryScreen.accessRestored')}</h1>
            <InlineAlert tone="success" title={t('RecoveryScreen.passwordChangedTitle')}>
              {t('RecoveryScreen.completedBody')}
            </InlineAlert>
            <div className="tm-id-action-row">
              <Link className="tm-button tm-button--ink tm-button--accessible" href="/sign-in">
                {t('RecoveryScreen.signIn')}
              </Link>
            </div>
          </section>
        </div>
      ) : null}
    </IdentityShell>
  );
}

function describeFailure(error: unknown, tr: (key: string) => string): string {
  if (error instanceof NetworkError) return tr('Recovery.noAnswer');
  if (error instanceof ApiRequestError && error.status === 429) return tr('Recovery.tooMany');
  return tr('Recovery.genericError');
}
