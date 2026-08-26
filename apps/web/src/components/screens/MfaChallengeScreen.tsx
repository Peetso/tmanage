'use client';

import { useState } from 'react';
import { Button, Field, InlineAlert, StatusDot } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { BackendPending } from './BackendPending';

/** The fallbacks `22-SCREEN-BY-SCREEN` §3 requires ID-02 to offer. */
const FALLBACKS = [
  { id: 'passkey', label: 'Use a passkey on this device', action: 'Use' },
  { id: 'recovery', label: 'Enter a recovery code', action: 'Enter' },
  { id: 'admin', label: 'Ask an admin to verify you', action: 'Request' },
] as const;

export interface MfaChallengeScreenProps {
  /** The organization requiring the second factor. Device context, per `22` §3. */
  organizationName?: string;
  /** How the code was delivered. Shown so a person knows where to look for it. */
  method?: string;
  /** Renders the rate-limited state instead of the ordinary one. */
  rateLimited?: boolean;
}

/**
 * **ID-02 MFA / passkey challenge.**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Show method, device context, fallback policy, trust-device
 * duration. Never expose whether an unrelated account exists."
 *
 * The second rule is why this screen names no email address and no account. It says which
 * organization asked for the factor and which method was used; it does not confirm that any
 * particular person exists.
 *
 * ## The code field is one input, not six boxes
 *
 * The export draws six character cells. Six separate `<input>` elements is the usual way to
 * build that and it is a known accessibility failure: a screen reader announces six unlabelled
 * fields, a password manager cannot fill it, paste behaves differently in every browser, and
 * backspace has to be re-implemented. One `<input inputmode="numeric" autocomplete="one-time-code">`
 * gets platform autofill, paste, and a single announcement — and can be *styled* as cells later
 * without changing any of that. `40-DESIGN-SYSTEM` §1 gives the export authority over
 * composition, not over the elements underneath it.
 *
 * Nothing verifies the code. ID-002 is unwritten; the field validates its shape and refuses to
 * submit, and says why.
 */
export function MfaChallengeScreen({
  organizationName = 'your organization',
  method = 'Authenticator app',
  rateLimited = false,
}: MfaChallengeScreenProps) {
  const [code, setCode] = useState('');
  const [shapeError, setShapeError] = useState<string | undefined>(undefined);

  const digitsOnly = code.replace(/\D/g, '');
  const complete = digitsOnly.length === 6;

  return (
    <IdentityShell screenId="ID-02" eyebrow="Second factor">
      <div className="tm-stack tm-stack--tight">
        <h1 className="tm-identity__title">Confirm it&rsquo;s you</h1>
        <p className="tm-prose">
          {organizationName} requires a second factor for internal members.
        </p>
        <StatusDot tone="neutral">{method}</StatusDot>
      </div>

      {rateLimited ? (
        <InlineAlert tone="danger" title="Rate limited" live>
          Too many attempts. Try again in a few minutes, or use a recovery code. The attempt was
          recorded in the audit log.
        </InlineAlert>
      ) : (
        <BackendPending ticket="ID-002">
          Nothing verifies this code yet. The field checks that six digits were entered and stops
          there.
        </BackendPending>
      )}

      <form
        className="tm-stack"
        onSubmit={(event) => {
          event.preventDefault();
          setShapeError(
            complete ? 'Verification is not built yet (ID-002).' : 'Enter all six digits.',
          );
        }}
      >
        <Field
          label="Six-digit code"
          name="code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setShapeError(undefined);
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          // Codes are digits in every locale, so the field stays LTR even in an RTL document.
          dir="ltr"
          hint="From your authenticator app."
          disabled={rateLimited}
          {...(shapeError === undefined ? {} : { error: shapeError })}
        />

        <div className="tm-row">
          <Button type="submit" tone="ink" size="accessible" disabled={rateLimited}>
            Verify
          </Button>
        </div>
      </form>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-mfa-fallbacks">
        <h2 id="tm-mfa-fallbacks" className="tm-eyebrow">
          Fallbacks
        </h2>
        <ul className="tm-stack tm-stack--tight tm-list">
          {FALLBACKS.map((fallback) => (
            <li key={fallback.id} className="tm-row">
              <span className="tm-prose">{fallback.label}</span>
              <span className="tm-push-end">
                {/*
                  The accessible name is the whole sentence, not the word on the button.
                  Three buttons reading "Use", "Enter" and "Request" are three buttons a
                  screen-reader user cannot tell apart in a list of controls.
                */}
                <Button tone="outline" size="compact" disabled aria-label={fallback.label}>
                  {fallback.action}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </IdentityShell>
  );
}
