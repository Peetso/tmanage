'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { developmentSignIn } from '../../lib/api/session';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SignInScreenProps {
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
  /** Injected in tests so navigation can be asserted without a router. */
  onSignedIn?: () => void;
  /**
   * Whether the development sign-in panel is rendered at all.
   *
   * Mirrors the API, which does not *register* `/v1/dev/sessions` in production rather than
   * registering it and refusing — a route that exists and returns 403 is one edit away from
   * existing and returning a session.
   */
  developmentSignInEnabled?: boolean;
}

/**
 * **ID-01 Sign in.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Purpose: authenticate with email/passkey/SSO. Content: product
 * mark, organization-aware SSO when known, privacy/support links. Actions: continue, use
 * passkey, enterprise SSO, recovery."
 *
 * All four of those actions are disabled, and the screen says so. ID-002 is unwritten:
 * nothing in this system checks a password, verifies a passkey, or talks to an identity
 * provider. The layout is the export's, the copy is the specification's, and the controls
 * are inert with a named reason — see `BackendPending`.
 *
 * What does work is the development sign-in, which posts a user id the server takes on
 * trust. It is fenced into its own panel, labelled as development-only, and rendered only
 * when the API would accept it. That is the honest shape: the one working path is the one
 * that visibly is not authentication.
 *
 * ## What this screen deliberately does not do
 *
 * - It does not tell the caller whether an email address is known. `22` §3 for ID-02 —
 *   "Never expose whether an unrelated account exists" — applies here too: an error that
 *   distinguished "no such account" from "wrong password" would enumerate the customer base.
 *   The error copy is the export's and names neither.
 * - It emits no `sign_in_started` / `succeeded` / `failed` events. `34-ANALYTICS` defines
 *   them and no telemetry transport exists; firing them into a console is not instrumentation.
 */
export function SignInScreen({
  client,
  onSignedIn,
  developmentSignInEnabled = process.env.NODE_ENV !== 'production',
}: SignInScreenProps) {
  const [userId, setUserId] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'signed-in'>('idle');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  async function submitDevelopmentSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId.trim() === '') {
      setFailure('Enter the user id to sign in as.');
      return;
    }

    setState('working');
    setFailure(undefined);

    try {
      await developmentSignIn(client ?? browserApiClient(), userId.trim());
      setState('signed-in');
      onSignedIn?.();
    } catch (error) {
      setState('idle');
      if (error instanceof ApiRequestError) {
        setFailure(error.message);
      } else if (error instanceof NetworkError) {
        setFailure('The API did not answer. Is it running?');
      } else {
        setFailure('Something went wrong. Try again.');
      }
    }
  }

  return (
    <IdentityShell
      screenId="ID-01"
      eyebrow="Sign in"
      footer={
        <>
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/support">Support</Link>
          <Link href="/legal/accessibility">Accessibility</Link>
        </>
      }
    >
      <div className="tm-stack tm-stack--tight">
        <h1 className="tm-identity__title">Sign in</h1>
        <p className="tm-prose">You will choose the organization after this step.</p>
      </div>

      <BackendPending ticket="ID-002">
        Passwords, passkeys and company SSO are not built. The controls below are shown as the
        design specifies them and are switched off until there is something behind them.
      </BackendPending>

      <div className="tm-stack tm-stack--tight">
        <Button tone="ink" size="accessible" disabled>
          Continue with a passkey
        </Button>
        <Button tone="outline" size="accessible" disabled>
          Continue with your company SSO
        </Button>
      </div>

      <p className="tm-divider">Or email</p>

      {/*
        A real form, with a real submit button, so the field semantics and the tab order are
        the ones a person will eventually use. `onSubmit` is prevented and the submit control
        is disabled — the form cannot post anywhere, because there is nowhere to post to.
      */}
      <form
        className="tm-stack"
        onSubmit={(event) => event.preventDefault()}
        aria-describedby="tm-sign-in-unavailable"
      >
        <Field
          label="Work email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          // 22 §3: "Mobile/RTL: single column; email direction remains LTR."
          dir="ltr"
          disabled
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          disabled
        />
        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled>
            Sign in
          </Button>
          <Link href="/recover">Forgot access</Link>
        </div>
        <p id="tm-sign-in-unavailable" className="tm-visually-hidden">
          Email sign-in is not available yet. It is delivered by ticket ID-002.
        </p>
      </form>

      <InlineAlert tone="neutral">
        Client reviewers usually arrive from a portal link and do not need a password.
      </InlineAlert>

      {developmentSignInEnabled ? (
        <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-dev-sign-in">
          <h2 id="tm-dev-sign-in" className="tm-eyebrow">
            Development sign-in — not authentication
          </h2>
          <p className="tm-prose">
            This posts a user id the API accepts on trust. It exists so the screens behind sign-in
            can be built before ID-002 lands, and it is not registered in production.
          </p>

          <form className="tm-stack" onSubmit={submitDevelopmentSignIn}>
            <Field
              label="User id"
              name="userId"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              hint="The uuid of an existing row in users."
              {...(failure === undefined ? {} : { error: failure })}
            />
            <div className="tm-row">
              <Button
                type="submit"
                tone="lime"
                loading={state === 'working'}
                loadingLabel="Starting a session"
              >
                Start a development session
              </Button>
            </div>
          </form>

          {state === 'signed-in' ? (
            <InlineAlert tone="success" title="Session started" live>
              The session cookies are set. Choose an organization next.
            </InlineAlert>
          ) : null}
        </section>
      ) : null}
    </IdentityShell>
  );
}
