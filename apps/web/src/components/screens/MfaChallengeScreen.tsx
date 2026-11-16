'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { IdentityShell } from '../shell/IdentityShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  completeMfaChallenge,
  completeWithRecoveryCode,
  sendSignInEmailCode,
} from '../../lib/api/auth';
import type { ApiClient } from '../../lib/api/client';
import { useHydrated } from '../../lib/use-hydrated';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDescribeApiError } from '../../lib/api/describe-error';
import { SixDigitCode } from './SixDigitCode';
import '../../styles/screens/identity.css';

/** One enabled method, as the challenge lists it (default first). No secrets, no identifiers. */
export interface ChallengeFactor {
  readonly kind: string;
  readonly label: string;
}

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
  /**
   * MFAOPTIONS. The person's enabled methods from the challenge, the default first. The server
   * decides this list; the screen only offers what is in it (plus backup codes, always). Absent =
   * an authenticator app.
   */
  factors?: readonly ChallengeFactor[];
  /** Renders the rate-limited state without needing to fail five times to see it. */
  rateLimited?: boolean;
  onCompleted?: () => void;
}

type Method = 'totp' | 'email' | 'recovery';

/** What the e-mail method has done so far in this challenge. */
type EmailState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'sending' }
  | { readonly phase: 'sent'; readonly sentTo: string; readonly resendAt: number };

const DEFAULT_FACTORS: readonly ChallengeFactor[] = [{ kind: 'totp', label: 'Authenticator app' }];

/**
 * **ID-02 two-step challenge (MFAOPTIONS).**
 *
 * `22-SCREEN-BY-SCREEN` §3: "Show method, device context, fallback policy. Never expose whether an
 * unrelated account exists." The default method's code field comes first; "Try another way" lists
 * the person's other enabled methods and backup codes. For the e-mail method the address is shown
 * masked (`p•••@domain`) as the API returned it, with a 30-second wait before a new code.
 *
 * ## The code field is one input, not six boxes
 *
 * {@link SixDigitCode}: one input under six painted cells, hidden from assistive technology.
 *
 * ## One endpoint per credential
 *
 * An authenticator or e-mail code goes to `/v1/auth/mfa` (with `method: 'email'` for the second);
 * a backup code goes to `/v1/auth/recovery-code`, because it is spent forever. The person chooses
 * rather than the screen guessing from the shape of what they typed.
 */
export function MfaChallengeScreen({
  client,
  challengeToken,
  factors = DEFAULT_FACTORS,
  rateLimited = false,
  onCompleted,
}: MfaChallengeScreenProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const t = useT();
  const tOr = useTOr();

  // Reached at its own route, the form's controlled inputs are in the server HTML with no query to
  // gate them. They hang on the hydration signal instead — disabled in the server render, enabled
  // once React is live — so a code typed on a cold page survives hydration.
  const hydrated = useHydrated();
  const codeId = useId();

  const totpFactor = factors.find((factor) => factor.kind === 'totp');
  const hasEmail = factors.some((factor) => factor.kind === 'email');
  const firstMethod: Method = factors[0]?.kind === 'email' ? 'email' : 'totp';

  const [method, setMethod] = useState<Method>(firstMethod);
  const [value, setValue] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [email, setEmail] = useState<EmailState>({ phase: 'idle' });
  const now = useNow(email.phase === 'sent');

  const digitsOnly = value.replace(/\D/g, '');
  const codeLooksComplete = method === 'recovery' ? value.trim() !== '' : digitsOnly.length === 6;

  const sendEmailCode = useCallback(async () => {
    if (!challengeToken) return;
    setEmail({ phase: 'sending' });
    setFailure(undefined);
    try {
      const sent = await sendSignInEmailCode(api, { challengeToken });
      setEmail({
        phase: 'sent',
        sentTo: sent.sentTo,
        resendAt: Date.now() + sent.resendAfterSeconds * 1000,
      });
    } catch (error) {
      setEmail({ phase: 'idle' });
      setFailure(describe(error));
    }
  }, [api, challengeToken, describe]);

  // The e-mail method as the default: one code is sent when the step opens. The ref keeps a
  // development double-mount from sending two.
  const autoSent = useRef(false);
  useEffect(() => {
    if (autoSent.current || firstMethod !== 'email' || !challengeToken || rateLimited) return;
    autoSent.current = true;
    void sendEmailCode();
  }, [firstMethod, challengeToken, rateLimited, sendEmailCode]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!challengeToken) {
      setFailure(t('MfaChallengeScreen.openedDirectly'));
      return;
    }
    if (!codeLooksComplete) {
      setFailure(
        method === 'recovery'
          ? t('MfaChallengeScreen.enterRecovery')
          : t('MfaChallengeScreen.enterAllDigits'),
      );
      return;
    }

    setWorking(true);
    setFailure(undefined);

    try {
      if (method === 'recovery') {
        await completeWithRecoveryCode(api, { challengeToken, code: value.trim() });
      } else if (method === 'email') {
        await completeMfaChallenge(api, { challengeToken, code: digitsOnly, method: 'email' });
      } else {
        await completeMfaChallenge(api, { challengeToken, code: digitsOnly });
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
    if (next === 'email' && email.phase === 'idle') void sendEmailCode();
  }

  if (challengeToken === undefined) {
    // Reached at its own route (`/sign-in/verify`): there is nothing to verify, so no code field,
    // no method choice and no fallbacks — just where to go instead.
    return (
      <IdentityShell
        screenId="ID-02"
        eyebrow={tOr('MfaChallengeScreen.eyebrow', 'Sign in')}
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

  const waitSeconds =
    email.phase === 'sent' ? Math.max(0, Math.ceil((email.resendAt - now) / 1000)) : 0;

  const lede =
    method === 'recovery'
      ? t('MfaChallengeScreen.recoveryLede')
      : method === 'totp'
        ? t('MfaChallengeScreen.totpLede')
        : email.phase === 'sent'
          ? // Isolated: a Latin address must not pull an Arabic sentence's full stop to its side.
            t('MfaChallengeScreen.emailLede').replace('{address}', `⁨${email.sentTo}⁩`)
          : t('MfaChallengeScreen.emailSending');

  const others: {
    readonly method: Method;
    readonly glyph: string;
    readonly name: string;
    readonly action: string;
  }[] = [];
  if (method !== 'email' && hasEmail) {
    others.push({
      method: 'email',
      glyph: '@',
      name: t('MfaChallengeScreen.useEmail'),
      action: t('MfaChallengeScreen.send'),
    });
  }
  if (method !== 'totp' && totpFactor) {
    others.push({
      method: 'totp',
      glyph: '#',
      name: t('MfaChallengeScreen.useApp'),
      action: t('MfaChallengeScreen.use'),
    });
  }
  if (method !== 'recovery') {
    others.push({
      method: 'recovery',
      glyph: '▤',
      name: t('MfaChallengeScreen.useBackup'),
      action: t('MfaChallengeScreen.enter'),
    });
  }

  return (
    <IdentityShell screenId="ID-02" eyebrow={tOr('MfaChallengeScreen.eyebrow', 'Sign in')}>
      <form className="tm-id-bare tm-id-card tm-id-mfa" noValidate onSubmit={submit}>
        <fieldset className="tm-fieldset tm-stack" disabled={!hydrated}>
          <div className="tm-id-intro">
            <h1 className="tm-identity__title">{t('MfaChallengeScreen.title')}</h1>
            <p className="tm-id-lede" aria-live="polite">
              {lede}
            </p>
          </div>

          {method === 'recovery' ? (
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
          ) : (
            <div className="tm-id-code">
              <label className="tm-field__label" htmlFor={codeId}>
                {t('MfaChallengeScreen.sixDigitCode')}
              </label>
              <SixDigitCode
                id={codeId}
                value={value}
                onChange={(next) => {
                  setValue(next);
                  setFailure(undefined);
                }}
                describedBy={`${codeId}-hint`}
                disabled={rateLimited || (method === 'email' && email.phase !== 'sent')}
              />
              <span className="tm-field__hint" id={`${codeId}-hint`}>
                {method === 'email'
                  ? t('MfaChallengeScreen.emailHint')
                  : t('MfaChallengeScreen.codeHint')}
              </span>
            </div>
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
              disabled={rateLimited || (method === 'email' && email.phase !== 'sent')}
              loading={working}
              loadingLabel={t('MfaChallengeScreen.verifying')}
            >
              {t('MfaChallengeScreen.verify')}
            </Button>
            {method === 'totp' && totpFactor ? (
              <p className="tm-id-expiry">
                <span className="tm-visually-hidden">{t('MfaChallengeScreen.factorPrefix')}</span>
                <span>{totpFactor.label}</span>
              </p>
            ) : null}
            {method === 'email' && email.phase === 'sent' ? (
              waitSeconds > 0 ? (
                <p className="tm-id-expiry" aria-live="off">
                  {t('MfaChallengeScreen.newCodeIn').replace('{time}', clock(waitSeconds))}
                </p>
              ) : (
                <button type="button" className="tm-id-resend" onClick={() => void sendEmailCode()}>
                  {t('MfaChallengeScreen.resend')}
                </button>
              )
            ) : null}
          </div>
        </fieldset>
      </form>

      {others.length > 0 ? (
        <section className="tm-id-fallbacks" aria-labelledby={`${codeId}-others`}>
          <h2 id={`${codeId}-others`} className="tm-id-fallbacks__title">
            {t('MfaChallengeScreen.tryAnotherWay')}
          </h2>
          {others.map((other) => (
            <button
              key={other.method}
              type="button"
              className="tm-id-fallback"
              disabled={!hydrated || working}
              onClick={() => choose(other.method)}
            >
              <span className="tm-id-fallback__glyph" aria-hidden="true">
                {other.glyph}
              </span>
              <span className="tm-id-fallback__text">
                <span className="tm-id-fallback__name">{other.name}</span>
              </span>
              <span className="tm-id-fallback__action" aria-hidden="true">
                {other.action}
              </span>
            </button>
          ))}
        </section>
      ) : null}

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

/** `24` → `0:24`. */
function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The current time, ticking once a second while `running`. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}
