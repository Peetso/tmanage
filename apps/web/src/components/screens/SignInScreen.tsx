'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { MfaChallengeScreen } from './MfaChallengeScreen';
import { browserApiClient } from '../../lib/api/browser-client';
import { signInWithPassword, type MfaRequiredResponse } from '../../lib/api/auth';
import { developmentSignIn } from '../../lib/api/session';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { authBoundary, type AuthBoundary } from '../../lib/auth-boundary';
import { useHydrated } from '../../lib/use-hydrated';
import { isPublicSignupOffered } from '../../lib/public-signup';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { takeGooglePendingMfa } from '../../lib/api/google-auth';
import { GoogleSignInButton, googleErrorKey, useGoogleAvailability } from './GoogleSignInButton';
import '../../styles/screens/identity.css';

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
   *
   * It is still rendered even though real sign-in now works, because it is the only way to
   * reach a session for a user who has never set a password — which is every seeded user
   * until TEN-001 provisions one.
   */
  developmentSignInEnabled?: boolean;
  /** Whether "Create an account" is shown. Defaults to the `PUBLIC_SIGNUP` build flag. */
  signUpOffered?: boolean;
  /** Injected in tests. Defaults to the application's boundary. */
  boundary?: AuthBoundary;
}

/**
 * **ID-01 Sign in.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Purpose: authenticate with email/passkey/SSO. Content: product
 * mark, organization-aware SSO when known, privacy/support links. Actions: continue, use
 * passkey, enterprise SSO, recovery."
 *
 * Email and password are real as of ID-002. Passkeys and enterprise SSO are not, and their
 * controls stay disabled and labelled — `04-SECURITY-PRIVACY` §3 lists both, and neither can
 * be built on a machine with no browser authenticator and no identity provider.
 *
 * ## The second factor renders here rather than at its own route
 *
 * When the API answers `mfa_required` it returns a challenge token. That token is a
 * credential-adjacent value, and the obvious way to carry it to `/sign-in/verify` — a query
 * parameter — would put it in the address bar, in browser history, and in the `Referer`
 * header of the next outbound request. `localStorage` is forbidden by the workspace lint
 * rule and would be worse.
 *
 * So the challenge is held in React state and `MfaChallengeScreen` is rendered in place. A
 * reload loses it and sends the person back to the password step, which is the right trade:
 * it costs them one password and costs an attacker the whole token.
 *
 * ## What this screen still refuses to do
 *
 * It does not tell the caller whether an email address is known. The API returns one refusal
 * for an unknown address, an address with no password, and a wrong password — asserted
 * byte-for-byte in `id-002-auth-http.db.test.ts` — and this screen renders whatever it is
 * given rather than trying to be more helpful.
 *
 * It emits no `sign_in_started` / `succeeded` / `failed` events. `34-ANALYTICS` defines them
 * and there is no telemetry transport; firing them into a console is not instrumentation.
 */
export function SignInScreen({
  client,
  onSignedIn,
  developmentSignInEnabled = process.env.NODE_ENV !== 'production',
  signUpOffered = isPublicSignupOffered(),
  boundary = authBoundary,
}: SignInScreenProps) {
  const api = client ?? browserApiClient();

  /**
   * There is no query to gate the fields on — this is a cold sign-in page, and email and
   * password are the most damaging things to lose to the hydration wipe. So the controls are
   * disabled until React is live: the server render has `hydrated === false`, ships the fields
   * disabled, and the first render after hydration enables them.
   */
  const hydrated = useHydrated();
  const t = useT();

  /**
   * A new principal is a boundary (review finding D01). Announced before the caller
   * navigates, so whatever the previous person left in the caches is gone before the next
   * screen mounts and starts reading.
   */
  function signedIn() {
    boundary.announce('signed-in');
    onSignedIn?.();
  }

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signingIn, setSigningIn] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [challenge, setChallenge] = useState<MfaRequiredResponse | undefined>(undefined);

  const [userId, setUserId] = useState('');
  const [developmentState, setDevelopmentState] = useState<'idle' | 'working' | 'signed-in'>(
    'idle',
  );
  const [developmentFailure, setDevelopmentFailure] = useState<string | undefined>(undefined);

  // "Continue with Google": shown only when the API has it configured.
  const google = useGoogleAvailability(api);
  const [googleError, setGoogleError] = useState<MessageKey | undefined>(undefined);
  /** Where a Google sign-in that needed a second factor goes afterwards (e.g. the invitation). */
  const [googleReturnTo, setGoogleReturnTo] = useState<string | undefined>(undefined);

  useEffect(() => {
    const search = window.location.search;
    setGoogleError(googleErrorKey(search));
    if (new URLSearchParams(search).get('google') !== 'mfa') return;
    let cancelled = false;
    // The challenge was parked in an HttpOnly cookie by the callback; it is taken once, here,
    // and kept in React state like a password sign-in's — never in the URL.
    takeGooglePendingMfa(api)
      .then((pending) => {
        if (cancelled || !pending) return;
        setGoogleReturnTo(pending.returnTo);
        setChallenge({
          status: 'mfa_required',
          challengeToken: pending.challengeToken,
          expiresAt: pending.expiresAt,
          factors: pending.factors,
        });
      })
      .catch(() => {
        if (!cancelled) setGoogleError('google.error.failed');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (email.trim() === '' || password === '') {
      setFailure('Enter your work email and password.');
      return;
    }

    setSigningIn(true);
    setFailure(undefined);

    try {
      const outcome = await signInWithPassword(api, { email: email.trim(), password });
      if (outcome.status === 'mfa_required') {
        setChallenge(outcome);
        // The password is dropped the moment it is no longer needed. It has already been
        // sent; keeping it in state for the rest of the sign-in buys nothing and leaves it in
        // a React fibre, in a devtools inspection, and in any error report that serialises it.
        setPassword('');
        return;
      }
      signedIn();
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setSigningIn(false);
    }
  }

  if (challenge) {
    return (
      <MfaChallengeScreen
        client={api}
        challengeToken={challenge.challengeToken}
        {...(challenge.factors[0] ? { factorLabel: challenge.factors[0].label } : {})}
        onCompleted={() => {
          if (
            googleReturnTo &&
            googleReturnTo.startsWith('/') &&
            googleReturnTo !== '/organizations'
          ) {
            boundary.announce('signed-in');
            window.location.assign(googleReturnTo);
            return;
          }
          signedIn();
        }}
      />
    );
  }

  async function submitDevelopmentSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId.trim() === '') {
      setDevelopmentFailure('Enter the user id to sign in as.');
      return;
    }

    setDevelopmentState('working');
    setDevelopmentFailure(undefined);

    try {
      await developmentSignIn(api, userId.trim());
      setDevelopmentState('signed-in');
      signedIn();
    } catch (error) {
      setDevelopmentState('idle');
      setDevelopmentFailure(describe(error));
    }
  }

  return (
    <IdentityShell
      screenId="ID-01"
      eyebrow="Sign in"
      footer={
        <>
          <Link href="/legal/privacy">Privacy</Link>
          {/* `/support` and `/legal/accessibility` are not published routes — both 404'd (ACC-13).
              Contact is the live page that reaches a person, so both point there. */}
          <Link href="/contact">Support</Link>
          <Link href="/contact">Accessibility</Link>
        </>
      }
    >
      <div className="tm-id-intro">
        <h1 className="tm-identity__title">Sign in</h1>
        <p className="tm-id-lede">You will choose the organization after this step.</p>
      </div>

      {/*
        Passkeys and company SSO are not built (WebAuthn needs a browser authenticator, SSO an
        identity provider), so both stay disabled and the line under them says so in plain words.
      */}
      {googleError ? (
        <InlineAlert tone="danger" live>
          {t(googleError)}
          {googleError === 'google.error.noAccount' && signUpOffered ? (
            <>
              {' '}
              <Link href="/sign-up">{t('signIn.createAccount')}</Link>
            </>
          ) : null}
        </InlineAlert>
      ) : null}

      <div className="tm-id-methods">
        {google ? <GoogleSignInButton api={api} input={() => ({ intent: 'sign-in' })} /> : null}
        <Button tone="ink" size="accessible" disabled aria-describedby="tm-sign-in-methods-note">
          <span className="tm-id-orb" aria-hidden="true">
            ◉
          </span>
          Continue with a passkey
        </Button>
        <Button
          tone="outline"
          size="accessible"
          disabled
          aria-describedby="tm-sign-in-methods-note"
        >
          Continue with your company SSO
        </Button>
        <p className="tm-id-methods__note" id="tm-sign-in-methods-note">
          <strong>Not available yet</strong> — sign in with your work email below.
        </p>
      </div>

      <p className="tm-divider">Or email</p>

      {/*
        `noValidate` because this form does its own checking and reports it through the design
        system's error affordance. Without it the browser refuses to submit an
        `input[type="email"]` it dislikes and shows a native bubble instead — unstyleable, not
        associated with the field for a screen reader, and gone on the next click.
      */}
      <form className="tm-stack" noValidate onSubmit={submit}>
        <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
          <Field
            label="Work email"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            // 22 §3: "Mobile/RTL: single column; email direction remains LTR."
            dir="ltr"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setFailure(undefined);
            }}
            required
          />
          <Field
            label="Password"
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFailure(undefined);
            }}
            required
          />

          {failure ? (
            <InlineAlert tone="danger" title="Could not sign you in" live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-id-action-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={signingIn}
              loadingLabel="Signing in"
            >
              Sign in
            </Button>
            <Link className="tm-id-link" href="/recover">
              Forgot access
            </Link>
          </div>
        </fieldset>
      </form>

      {signUpOffered ? (
        <p className="tm-id-lede">
          {t('signIn.newHere')} <Link href="/sign-up">{t('signIn.createAccount')}</Link>
        </p>
      ) : null}

      <InlineAlert tone="neutral">
        Client reviewers usually arrive through an invitation or portal link — open that link to set
        up your access.
      </InlineAlert>

      {developmentSignInEnabled ? (
        <details className="tm-id-dev">
          <summary>Development sign-in — not authentication</summary>
          <p className="tm-prose">
            This posts a user id the API accepts on trust. It is how a seeded account that has never
            set a password can still be reached, and it is not registered in production.
          </p>

          <form className="tm-stack" noValidate onSubmit={submitDevelopmentSignIn}>
            <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
              <Field
                label="User id"
                name="userId"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                hint="The uuid of an existing row in users."
                {...(developmentFailure === undefined ? {} : { error: developmentFailure })}
              />
              <div className="tm-row">
                <Button
                  type="submit"
                  tone="lime"
                  loading={developmentState === 'working'}
                  loadingLabel="Starting a session"
                >
                  Start a development session
                </Button>
              </div>
            </fieldset>
          </form>

          {developmentState === 'signed-in' ? (
            <InlineAlert tone="success" title="Session started" live>
              The session cookies are set. Choose an organization next.
            </InlineAlert>
          ) : null}
        </details>
      ) : null}
    </IdentityShell>
  );
}

/**
 * Turn a thrown value into a sentence.
 *
 * `ApiRequestError.message` is rendered verbatim, and that is safe precisely because the API
 * is careful: every credential refusal carries the same message, so there is nothing here to
 * leak. A screen that rewrote the message per status would be reintroducing the distinction
 * the API removed.
 */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
