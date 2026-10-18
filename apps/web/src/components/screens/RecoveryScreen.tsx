'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
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

/** The honest fallback, in every state a person might be stuck in. */
const ADMIN_FALLBACK =
  'If no email arrives, ask whoever administers your TManage workspace to invite you again or to help you back in.';

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
      eyebrow="Recovery"
      footer={<Link href="/sign-in">Back to sign in</Link>}
    >
      {state === 'request' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--ink">
            <span className="tm-id-step tm-id-step--ink">Request</span>
            <h1 className="tm-id-card__title">Recover access</h1>
            <p className="tm-id-card__body">
              We will send a link to your work email. It works once and expires in 30 minutes.
            </p>
            <form
              className="tm-stack tm-stack--tight"
              noValidate
              onSubmit={(event) => void sendLink(event)}
            >
              <Field
                label="Work email"
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
                <InlineAlert tone="danger" title="That did not go through" live>
                  {failure}
                </InlineAlert>
              ) : null}
              <div className="tm-id-action-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={busy}
                  loadingLabel="Sending"
                  disabled={email.trim() === ''}
                >
                  Send a recovery link
                </Button>
              </div>
            </form>
          </section>
          <p className="tm-id-card__body">{ADMIN_FALLBACK}</p>
        </div>
      ) : null}

      {state === 'sent' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card">
            <span className="tm-id-step">Sent</span>
            <h1 className="tm-id-card__title">Check your email</h1>
            <InlineAlert tone="neutral" title="A link may be on its way">
              If an account exists for that address, a link is on its way. The link works once and
              expires in 30 minutes.
            </InlineAlert>
            <p className="tm-id-card__body">
              We do not say whether an account exists for an address. That is deliberate: it would
              let anyone check who uses TManage.
            </p>
          </section>
          <p className="tm-id-card__body">{ADMIN_FALLBACK}</p>
        </div>
      ) : null}

      {state === 'reset' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--ink">
            <span className="tm-id-step tm-id-step--ink">New password</span>
            <h1 className="tm-id-card__title">Choose a new password</h1>
            <p className="tm-id-card__body">
              After this, every device signed in to your account is signed out, and you sign in
              again with the new password.
            </p>
            <form
              className="tm-stack tm-stack--tight"
              noValidate
              onSubmit={(event) => void choosePassword(event)}
            >
              <Field
                label="New password"
                type="password"
                name="password"
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                hint={`At least ${MIN_PASSWORD} characters.`}
                required
                disabled={busy}
                {...(passwordError ? { error: passwordError } : {})}
              />
              {failure ? (
                <InlineAlert tone="danger" title="That did not go through" live>
                  {failure}
                </InlineAlert>
              ) : null}
              <div className="tm-id-action-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={busy}
                  loadingLabel="Saving"
                >
                  Save new password
                </Button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {state === 'expired' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--warning">
            <span className="tm-id-step tm-id-step--warning">Expired</span>
            <h1 className="tm-id-card__title">That link has expired</h1>
            <p className="tm-id-card__body">
              For safety we do not extend recovery links, and each one works once. Request a new one
              — it takes a few seconds.
            </p>
            <div className="tm-id-action-row">
              <Button
                tone="ink"
                size="accessible"
                onClick={() => {
                  setFailure(undefined);
                  setState('request');
                }}
              >
                Request a new link
              </Button>
            </div>
          </section>
          <p className="tm-id-card__body">{ADMIN_FALLBACK}</p>
        </div>
      ) : null}

      {state === 'completed' ? (
        <div className="tm-id-bare tm-stack">
          <section className="tm-id-card tm-id-card--success">
            <span className="tm-id-step tm-id-step--success">Completed</span>
            <h1 className="tm-id-card__title">Access restored</h1>
            <InlineAlert tone="success" title="Your password was changed">
              Every device signed in to your account was signed out, and we emailed you a note that
              the password changed. Sign in with your new password.
            </InlineAlert>
            <div className="tm-id-action-row">
              <Link className="tm-button tm-button--ink tm-button--accessible" href="/sign-in">
                Sign in
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
