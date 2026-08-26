'use client';

import { useState, type FormEvent } from 'react';
import { Button, Field, InlineAlert, StatusDot } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';
import { browserApiClient } from '../../lib/api/browser-client';
import { completeMfaChallenge, completeWithRecoveryCode } from '../../lib/api/auth';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface MfaChallengeScreenProps {
  client?: ApiClient;
  /**
   * The token `POST /v1/auth/password` returned.
   *
   * Absent when this screen is reached at its own route rather than as the second step of a
   * sign-in — there is no route that can produce one, because the token is deliberately never
   * put in a URL. The screen then renders its layout and says why it cannot do anything.
   */
  challengeToken?: string;
  /** The factor's label, from the challenge. Device context, per `22` §3. */
  factorLabel?: string;
  organizationName?: string;
  /** Renders the rate-limited state without needing to fail five times to see it. */
  rateLimited?: boolean;
  onCompleted?: () => void;
}

type Method = 'code' | 'recovery';

/**
 * **ID-02 MFA / passkey challenge.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Show method, device context, fallback policy, trust-device
 * duration. Never expose whether an unrelated account exists."
 *
 * The second rule is why this screen names no email address and no account. It says which
 * factor was asked for and offers the fallbacks; it confirms that no particular person exists.
 *
 * ## The code field is one input, not six boxes
 *
 * The export draws six character cells. Six separate `<input>` elements is the usual way to
 * build that and it is a known accessibility failure: a screen reader announces six unlabelled
 * fields, a password manager cannot fill it, paste behaves differently in every browser, and
 * backspace has to be re-implemented. One `<input inputmode="numeric"
 * autocomplete="one-time-code">` gets platform autofill, paste and a single announcement — and
 * can be *styled* as cells later without changing any of that. `40-DESIGN-SYSTEM` §1 gives the
 * export authority over composition, not over the elements underneath it.
 *
 * ## Two methods, one endpoint each
 *
 * A code from an authenticator and a recovery code go to different routes, because they are
 * different credentials with different consequences — one is reusable next time, the other is
 * spent forever. The screen makes the person choose rather than guessing from the shape of
 * what they typed: a six-digit recovery code is possible, and a wrong guess would spend one.
 */
export function MfaChallengeScreen({
  client,
  challengeToken,
  factorLabel = 'Authenticator app',
  organizationName,
  rateLimited = false,
  onCompleted,
}: MfaChallengeScreenProps) {
  const api = client ?? browserApiClient();

  const [method, setMethod] = useState<Method>('code');
  const [value, setValue] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const digitsOnly = value.replace(/\D/g, '');
  const codeLooksComplete = method === 'code' ? digitsOnly.length === 6 : value.trim() !== '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!challengeToken) {
      setFailure('This page was opened directly. Start again from the sign-in screen.');
      return;
    }
    if (!codeLooksComplete) {
      setFailure(method === 'code' ? 'Enter all six digits.' : 'Enter your recovery code.');
      return;
    }

    setWorking(true);
    setFailure(undefined);

    try {
      if (method === 'code') {
        await completeMfaChallenge(api, { challengeToken, code: digitsOnly });
      } else {
        await completeWithRecoveryCode(api, { challengeToken, code: value.trim() });
      }
      onCompleted?.();
    } catch (error) {
      setFailure(describe(error));
      setValue('');
    } finally {
      setWorking(false);
    }
  }

  return (
    <IdentityShell screenId="ID-02" eyebrow="Second factor">
      <div className="tm-stack tm-stack--tight">
        <h1 className="tm-identity__title">Confirm it&rsquo;s you</h1>
        <p className="tm-prose">
          {organizationName ?? 'Your organization'} requires a second factor for internal members.
        </p>
        <StatusDot tone="neutral">{factorLabel}</StatusDot>
      </div>

      {rateLimited ? (
        <InlineAlert tone="danger" title="Rate limited" live>
          Too many attempts. Try again in a few minutes, or use a recovery code. The attempt was
          recorded in the audit log.
        </InlineAlert>
      ) : null}

      {challengeToken === undefined ? (
        <InlineAlert tone="warning" title="There is nothing to verify here">
          This screen is the second step of a sign-in and holds the challenge in memory rather than
          in the address bar, so it cannot be reached directly. Start again from the sign-in screen.
        </InlineAlert>
      ) : null}

      <fieldset className="tm-fieldset">
        <legend className="tm-field__label">How do you want to verify?</legend>
        <div className="tm-stack tm-stack--tight">
          <label className="tm-choice">
            <input
              className="tm-choice__input"
              type="radio"
              name="method"
              value="code"
              checked={method === 'code'}
              onChange={() => {
                setMethod('code');
                setValue('');
                setFailure(undefined);
              }}
            />
            <span className="tm-choice__name">A code from your authenticator</span>
            <span className="tm-choice__detail">Six digits, from {factorLabel}.</span>
          </label>
          <label className="tm-choice">
            <input
              className="tm-choice__input"
              type="radio"
              name="method"
              value="recovery"
              checked={method === 'recovery'}
              onChange={() => {
                setMethod('recovery');
                setValue('');
                setFailure(undefined);
              }}
            />
            <span className="tm-choice__name">A recovery code</span>
            <span className="tm-choice__detail">
              One of the ten you saved. Each one works once.
            </span>
          </label>
        </div>
      </fieldset>

      <form className="tm-stack" noValidate onSubmit={submit}>
        {method === 'code' ? (
          <Field
            label="Six-digit code"
            name="code"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setFailure(undefined);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            // Codes are digits in every locale, so the field stays LTR in an RTL document.
            dir="ltr"
            hint="From your authenticator app."
            disabled={rateLimited}
          />
        ) : (
          <Field
            label="Recovery code"
            name="recoveryCode"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setFailure(undefined);
            }}
            autoComplete="one-time-code"
            spellCheck={false}
            dir="ltr"
            hint="Ten characters, in two groups. Case and hyphens do not matter."
            disabled={rateLimited}
          />
        )}

        {failure ? (
          <InlineAlert tone="danger" title="That did not work" live>
            {failure}
          </InlineAlert>
        ) : null}

        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            disabled={rateLimited || challengeToken === undefined}
            loading={working}
            loadingLabel="Verifying"
          >
            Verify
          </Button>
        </div>
      </form>

      <BackendPending ticket="ID-002 · passkeys">
        &ldquo;Use a passkey on this device&rdquo; and &ldquo;Ask an admin to verify you&rdquo; are
        not built. A passkey needs a browser authenticator; an admin-assisted verification needs the
        notification surface, which is a later ticket.
      </BackendPending>
    </IdentityShell>
  );
}

/**
 * Render the API's own message.
 *
 * Safe verbatim because the API is careful: a wrong code, a replayed code, an expired
 * challenge and a spent recovery code all carry the same message. Rewriting it per status
 * would reintroduce exactly the distinction the API removed.
 */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
