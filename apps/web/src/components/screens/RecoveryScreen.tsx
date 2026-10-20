'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
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
export function RecoveryScreen({ state: initial, token, client }: RecoveryScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const adminFallback = t('RecoveryScreen.adminFallback');
  const [state, setState] = useState<RecoveryState>(
    initial ?? (token === undefined ? 'request' : 'reset'),
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
    setBusy(true);
    try {
      await completePasswordReset(api, token, password);
      setPassword('');
      setState('completed');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setPassword('');
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
          <section className="tm-id-card tm-id-card--ink">
            <span className="tm-id-step tm-id-step--ink">
              {t('RecoveryScreen.stepNewPassword')}
            </span>
            <h1 className="tm-id-card__title">{t('RecoveryScreen.chooseNewPassword')}</h1>
            <p className="tm-id-card__body">{t('RecoveryScreen.resetBody')}</p>
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
                hint={`${t('RecoveryScreen.passwordHintPrefix')}${MIN_PASSWORD}${t('RecoveryScreen.passwordHintSuffix')}`}
                required
                disabled={busy}
                {...(passwordError ? { error: passwordError } : {})}
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
                  loadingLabel={t('RecoveryScreen.saving')}
                >
                  {t('RecoveryScreen.saveNewPassword')}
                </Button>
              </div>
            </form>
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

function describe(error: unknown): string {
  if (error instanceof NetworkError) {
    return 'The server did not answer. Check your connection and try again.';
  }
  if (error instanceof ApiRequestError && error.status === 429) {
    return 'Too many attempts. Wait a few minutes and try again.';
  }
  return 'Something went wrong. Try again.';
}
