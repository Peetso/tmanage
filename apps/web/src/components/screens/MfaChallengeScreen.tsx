'use client';

import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { completeMfaChallenge, completeWithRecoveryCode } from '../../lib/api/auth';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/identity.css';

export interface MfaChallengeScreenProps {
  client?: ApiClient;
  /**
   * The token `POST /v1/auth/password` returned.
   *
   * Absent when this screen is reached at its own route rather than as the second step of a
   * sign-in — there is no route that can produce one, because the token is deliberately never
   * put in a URL. The screen then renders only a not-reachable state — a title, one sentence and a
   * link back to sign-in — and none of the form, which could do nothing without a token.
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
  const t = useT();

  // Reached at its own route, the method radios and the code field are controlled inputs in the
  // server HTML with no query to gate them. They hang on the hydration signal instead — disabled
  // in the server render, enabled once React is live — so a code typed on a cold page survives
  // hydration. In the sign-in flow this screen is only ever mounted after React is already live,
  // where the signal is already true and the gate is a no-op.
  const hydrated = useHydrated();
  const codeId = useId();

  const [method, setMethod] = useState<Method>('code');
  const [value, setValue] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const digitsOnly = value.replace(/\D/g, '');
  const codeLooksComplete = method === 'code' ? digitsOnly.length === 6 : value.trim() !== '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!challengeToken) {
      setFailure(t('MfaChallengeScreen.openedDirectly'));
      return;
    }
    if (!codeLooksComplete) {
      setFailure(
        method === 'code'
          ? t('MfaChallengeScreen.enterAllDigits')
          : t('MfaChallengeScreen.enterRecovery'),
      );
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

  function choose(next: Method) {
    setMethod(next);
    setValue('');
    setFailure(undefined);
  }

  if (challengeToken === undefined) {
    // Reached at its own route (`/sign-in/verify`): there is nothing to verify, so no code field,
    // no method choice and no fallbacks — just where to go instead.
    return (
      <IdentityShell
        screenId="ID-02"
        eyebrow="Second factor"
        footer={<Link href="/sign-in">{t('RecoveryScreen.backToSignIn')}</Link>}
      >
        <div className="tm-id-bare tm-id-card tm-id-mfa tm-stack">
          <div className="tm-id-intro">
            <h1 className="tm-identity__title">{t('MfaChallengeScreen.nothingToVerifyTitle')}</h1>
            <p className="tm-id-lede">{t('MfaChallengeScreen.nothingToVerifyBody')}</p>
          </div>
        </div>
      </IdentityShell>
    );
  }

  const cells = Array.from({ length: 6 }, (_, index) => digitsOnly.charAt(index));
  const activeCell = Math.min(digitsOnly.length, 5);

  return (
    <IdentityShell screenId="ID-02" eyebrow="Second factor">
      <form className="tm-id-bare tm-id-card tm-id-mfa" noValidate onSubmit={submit}>
        <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
          <div className="tm-id-intro">
            <h1 className="tm-identity__title">{t('MfaChallengeScreen.title')}</h1>
            <p className="tm-id-lede">
              {organizationName ?? t('MfaChallengeScreen.orgFallback')}{' '}
              {t('MfaChallengeScreen.requiresSecondFactor')}
            </p>
          </div>

          {method === 'code' ? (
            <div className="tm-id-code">
              <label className="tm-field__label" htmlFor={codeId}>
                {t('MfaChallengeScreen.sixDigitCode')}
              </label>
              <div className="tm-id-code__frame">
                <input
                  id={codeId}
                  className="tm-id-code__input"
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
                  aria-describedby={`${codeId}-hint`}
                  disabled={rateLimited}
                />
                <div className="tm-id-code__cells" aria-hidden="true" dir="ltr">
                  {cells.map((digit, index) => (
                    <span
                      key={index}
                      className={[
                        'tm-id-code__cell',
                        digit === '' ? 'tm-id-code__cell--empty' : null,
                        index === activeCell ? 'tm-id-code__cell--active' : null,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {digit === '' ? '·' : digit}
                    </span>
                  ))}
                </div>
              </div>
              <span className="tm-field__hint" id={`${codeId}-hint`}>
                {t('MfaChallengeScreen.codeHint')}
              </span>
            </div>
          ) : (
            <Field
              className="tm-id-recovery-field"
              label={t('MfaChallengeScreen.recoveryLabel')}
              name="recoveryCode"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setFailure(undefined);
              }}
              autoComplete="one-time-code"
              spellCheck={false}
              dir="ltr"
              hint={t('MfaChallengeScreen.recoveryHint')}
              disabled={rateLimited}
            />
          )}

          {failure ? (
            <InlineAlert tone="danger" title={t('MfaChallengeScreen.didNotWork')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-id-action-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              disabled={rateLimited || challengeToken === undefined}
              loading={working}
              loadingLabel={t('MfaChallengeScreen.verifying')}
            >
              {t('MfaChallengeScreen.verify')}
            </Button>
            <p className="tm-id-expiry">
              <span className="tm-visually-hidden">{t('MfaChallengeScreen.factorPrefix')}</span>
              <span>{factorLabel}</span>
            </p>
          </div>
        </fieldset>
      </form>

      <fieldset className="tm-id-fallbacks" disabled={!hydrated}>
        <legend>{t('MfaChallengeScreen.howVerify')}</legend>
        <label className="tm-id-fallback">
          <input
            className="tm-id-fallback__input"
            type="radio"
            name="method"
            value="code"
            checked={method === 'code'}
            onChange={() => choose('code')}
          />
          <span className="tm-id-fallback__glyph" aria-hidden="true">
            #
          </span>
          <span className="tm-id-fallback__text">
            <span className="tm-id-fallback__name">{t('MfaChallengeScreen.codeMethodName')}</span>
            <span className="tm-id-fallback__detail">
              {t('MfaChallengeScreen.sixDigitsFrom')} {factorLabel}.
            </span>
          </span>
          <span className="tm-id-fallback__action" aria-hidden="true">
            {t('MfaChallengeScreen.use')}
          </span>
        </label>
        <label className="tm-id-fallback">
          <input
            className="tm-id-fallback__input"
            type="radio"
            name="method"
            value="recovery"
            checked={method === 'recovery'}
            onChange={() => choose('recovery')}
          />
          <span className="tm-id-fallback__glyph" aria-hidden="true">
            ▤
          </span>
          <span className="tm-id-fallback__text">
            <span className="tm-id-fallback__name">
              {t('MfaChallengeScreen.recoveryMethodName')}
            </span>
            <span className="tm-id-fallback__detail">
              {t('MfaChallengeScreen.recoveryMethodDetail')}
            </span>
          </span>
          <span className="tm-id-fallback__action" aria-hidden="true">
            {t('MfaChallengeScreen.enter')}
          </span>
        </label>
        {/* Passkeys and admin-assisted verification are not built: shown, never offered. */}
        <div className="tm-id-fallback tm-id-fallback--off">
          <span className="tm-id-fallback__glyph" aria-hidden="true">
            ◉
          </span>
          <span className="tm-id-fallback__text">
            <span className="tm-id-fallback__name">{t('MfaChallengeScreen.passkeyName')}</span>
          </span>
          <span className="tm-id-fallback__action">{t('MfaChallengeScreen.notAvailable')}</span>
        </div>
        <div className="tm-id-fallback tm-id-fallback--off">
          <span className="tm-id-fallback__glyph" aria-hidden="true">
            ✉
          </span>
          <span className="tm-id-fallback__text">
            <span className="tm-id-fallback__name">{t('MfaChallengeScreen.adminName')}</span>
          </span>
          <span className="tm-id-fallback__action">{t('MfaChallengeScreen.notAvailable')}</span>
        </div>
      </fieldset>

      {rateLimited ? (
        <InlineAlert
          className="tm-id-notice"
          tone="warning"
          title={t('MfaChallengeScreen.rateLimitedTitle')}
          live
        >
          {t('MfaChallengeScreen.rateLimitedBody')}
        </InlineAlert>
      ) : null}
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
